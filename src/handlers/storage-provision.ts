/**
 * storage-provision — MinIO Service-Account fuer einen Tenant erzeugen.
 *
 * Wird vom Backend ueber den Command "storage.provision_service_account"
 * getriggert (waehrend Provisioning oder spaeter via Backfill).
 *
 * Voraussetzung: lokaler `mc`-Client mit Alias `prilog-local` ist konfiguriert
 * (siehe install.sh / provision-shared.ts) und hat Root-Zugang zur MinIO.
 *
 * Vorgehen:
 *   1. Bucket sicherstellen (`mc mb`)
 *   2. Service-Account anlegen mit eingebetteter Policy: read+write nur
 *      auf den eigenen Bucket
 *   3. AccessKey + SecretKey zurueck an Backend
 *
 * Sicherheit:
 *   - Service-Account ist auf 1 Bucket beschraenkt
 *   - Es gibt keinen Listing-Zugriff auf andere Buckets oder MinIO-Admin
 *   - Wenn der Tenant geloescht wird, soll der Service-Account auch
 *     deaktiviert werden (separater Command, nicht hier)
 */

import { execFile } from 'child_process';
import { promisify } from 'util';
import { logger } from '../utils/logger.js';

const execFileP = promisify(execFile);

const MC_ALIAS = 'prilog-local';

export interface StorageProvisionArgs {
  /** Bucket-Name, z.B. "tenant-weser". Wird angelegt falls nicht existent. */
  bucket: string;
  /** Optionaler Anzeigename fuer den Service-Account. Default: "svc-{bucket}". */
  description?: string;
}

export interface StorageProvisionResult {
  bucket: string;
  accessKey: string;
  secretKey: string;
  /** MinIO-Endpoint, der vom Backend fuer presigned URLs genutzt wird. */
  endpoint: string;
}

async function mc(args: string[]): Promise<{ stdout: string; stderr: string }> {
  return execFileP('mc', args, { timeout: 30000 });
}

async function ensureBucket(bucket: string): Promise<void> {
  try {
    await mc(['mb', `${MC_ALIAS}/${bucket}`, '--ignore-existing']);
  } catch (err) {
    logger.error('[storage-provision] mc mb fehlgeschlagen', { err, bucket });
    throw new Error(`Bucket ${bucket} konnte nicht angelegt werden: ${(err as Error).message}`);
  }
}

/**
 * Erzeugt einen Service-Account mit Bucket-eingebetteter Policy.
 * `mc admin user svcacct add` liefert AccessKey + SecretKey im stdout.
 *
 * Format der mc-Ausgabe (variiert leicht je nach Version):
 *   Access Key: ABCDEF...
 *   Secret Key: ghijkl...
 */
async function createServiceAccount(bucket: string, description: string): Promise<{ accessKey: string; secretKey: string }> {
  // Inline-Policy als JSON: nur Bucket-spezifische Rechte.
  const policy = JSON.stringify({
    Version: '2012-10-17',
    Statement: [
      {
        Effect: 'Allow',
        Action: ['s3:ListBucket', 's3:GetBucketLocation'],
        Resource: [`arn:aws:s3:::${bucket}`],
      },
      {
        Effect: 'Allow',
        Action: ['s3:GetObject', 's3:PutObject', 's3:DeleteObject'],
        Resource: [`arn:aws:s3:::${bucket}/*`],
      },
    ],
  });

  // mc 2024+ unterstuetzt --policy-file mit stdin. Wir schreiben in tmp,
  // damit das auf aelteren Versionen funktioniert.
  const fs = await import('fs/promises');
  const path = await import('path');
  const tmpDir = await fs.mkdtemp(path.join('/tmp', 'svcacct-'));
  const policyPath = path.join(tmpDir, 'policy.json');
  await fs.writeFile(policyPath, policy);

  try {
    const { stdout } = await mc([
      'admin', 'user', 'svcacct', 'add',
      MC_ALIAS, 'minioadmin', // Owner-User; mc ist als minioadmin/Root authentifiziert via Alias
      '--policy', policyPath,
      '--description', description,
    ]);

    const accessMatch = /Access Key:\s*(\S+)/i.exec(stdout);
    const secretMatch = /Secret Key:\s*(\S+)/i.exec(stdout);
    if (!accessMatch || !secretMatch) {
      throw new Error(`mc-Ausgabe konnte nicht geparst werden:\n${stdout}`);
    }
    return { accessKey: accessMatch[1], secretKey: secretMatch[1] };
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  }
}

/**
 * Endpoint, den das Backend fuer S3-Client-Initialisierung nutzt.
 * Wir nehmen die offizielle Domain mit dem Nginx-Pfad, damit der Browser
 * (presigned URL) direkt darauf zugreifen kann.
 *
 * Hostname kommt aus MATRIX_DOMAIN (Standard-Env in prilog-agent-systemd-Unit).
 */
function buildEndpoint(): string {
  const domain = process.env.MATRIX_DOMAIN
    || process.env.AGENT_DOMAIN
    || process.env.HOSTNAME_FQDN
    || process.env.HOSTNAME
    || 'localhost';
  return `https://${domain}/s3`;
}

export async function provisionStorageServiceAccount(args: StorageProvisionArgs): Promise<StorageProvisionResult> {
  if (!args.bucket || !/^[a-z0-9-]+$/.test(args.bucket)) {
    throw new Error(`Ungueltiger Bucket-Name: ${args.bucket}`);
  }

  const description = args.description ?? `svc-${args.bucket}`;

  await ensureBucket(args.bucket);
  const { accessKey, secretKey } = await createServiceAccount(args.bucket, description);

  return {
    bucket: args.bucket,
    accessKey,
    secretKey,
    endpoint: buildEndpoint(),
  };
}
