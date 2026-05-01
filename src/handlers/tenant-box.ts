/**
 * handlers/tenant-box.ts
 *
 * Tenant-in-a-Box: pro Tenant ein vollständiger docker-compose Stack mit
 * Synapse + Postgres + MinIO im selben /srv/tenants/<slug>/ Verzeichnis.
 * Ablöst langfristig handlers/provision-shared.ts (das nutzt shared Postgres
 * + shared MinIO und produziert die State-Drift-Probleme aus 2026-04-30).
 *
 * Konzept: prilog_docs/docs/umsetzung/tenant-in-a-box-konzept.md
 *
 * Lifecycle-Operationen:
 *   tenant-box.create   Neuer Tenant von Null
 *   tenant-box.snapshot Atomarer Tarball (Stop-Tar-Start)
 *   tenant-box.restore  Wiederherstellung aus Tarball
 *   tenant-box.update   Versions-Bump mit Pre-Update-Snapshot + Auto-Rollback
 *   tenant-box.destroy  Compose down + dir entfernen (irreversibel)
 *
 * Schreibstil: jede Operation ist idempotent wo möglich. Fehler werden
 * mit klaren Meldungen reported, kein Silent-Fail.
 */

import { promises as fs } from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { safeExec } from '../provision/engine/safe-exec.js';
import { logger } from '../utils/logger.js';

// ─── Konstanten ─────────────────────────────────────────────────────────────

const TENANT_BOX_ROOT = '/srv/tenants';
const SNAPSHOT_DIR = '/var/lib/prilog/snapshots';
const MANIFEST_SCHEMA_VERSION = 1;

// Default-Versionen — werden langfristig vom Backend überschrieben (Version-
// Registry, siehe Konzept Sektion 4). Hier nur Fallback.
const DEFAULT_VERSIONS = {
  synapse: '1.95.0',
  postgres: '15-alpine',
  minio: 'RELEASE.2024-12-13T22-19-12Z',
} as const;

// ─── Config Schema ──────────────────────────────────────────────────────────

const TenantBoxConfigSchema = z.object({
  // Identität
  slug:        z.string().regex(/^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/),
  domain:      z.string(),                  // <slug>.prilog.team oder chat.firma.com
  serverName:  z.string(),                  // Matrix server_name — invariant über Lifecycle, meist <slug>.prilog.team
  publicBaseUrl: z.string(),                // https://<domain>/

  // Ports (auf Host-Ebene)
  synapsePort: z.number().int().min(8100).max(8299),
  minioPort:   z.number().int().min(9100).max(9299), // 127.0.0.1-bound, nginx proxy von extern

  // Postgres
  pgPassword:  z.string().min(16),

  // MinIO
  minioRootUser:     z.string().min(8),
  minioRootPassword: z.string().min(16),
  minioBucket:       z.string().default('default'),

  // Synapse
  registrationSecret: z.string().min(16),
  signingKey:         z.string().optional(),  // wenn vorhanden: bestehende Identität (z.B. bei Migration)

  // Versions (optional — sonst DEFAULT_VERSIONS)
  versions: z.object({
    synapse:  z.string().optional(),
    postgres: z.string().optional(),
    minio:    z.string().optional(),
  }).optional(),

  // Tier (für spätere Federation-Disable, Resource-Limits)
  tier: z.enum(['free', 'pro', 'enterprise']).default('pro'),
});

export type TenantBoxConfig = z.infer<typeof TenantBoxConfigSchema>;

type SendFn = (type: string, payload: unknown) => boolean;

// ─── Helpers ────────────────────────────────────────────────────────────────

function reply(send: SendFn, commandId: string, success: boolean, payload: Record<string, unknown> = {}) {
  send('agent.command_result', { commandId, success, ...payload });
}

function tenantDir(slug: string) {
  return path.join(TENANT_BOX_ROOT, slug);
}

function resolveVersions(config: TenantBoxConfig) {
  return {
    synapse:  config.versions?.synapse  ?? DEFAULT_VERSIONS.synapse,
    postgres: config.versions?.postgres ?? DEFAULT_VERSIONS.postgres,
    minio:    config.versions?.minio    ?? DEFAULT_VERSIONS.minio,
  };
}

function generateSigningKey(): string {
  const id = `a_${Math.random().toString(36).slice(2, 10)}`;
  const data = Buffer.from(Array.from({ length: 32 }, () => Math.floor(Math.random() * 256))).toString('base64');
  return `ed25519 ${id} ${data}`;
}

// ─── Template-Rendering ─────────────────────────────────────────────────────

function renderHomeserverYaml(config: TenantBoxConfig): string {
  const federationDisabled = config.tier === 'free' || config.tier === 'pro';
  const federationBlock = federationDisabled
    ? `\nfederation_domain_whitelist: []\n` // Leer = kein Server darf federieren
    : '';

  return `
server_name: "${config.serverName}"
pid_file: /data/homeserver.pid
public_baseurl: "${config.publicBaseUrl}"

listeners:
  - port: 8008
    type: http
    tls: false
    x_forwarded: true
    bind_addresses: ['0.0.0.0']
    resources:
      - names: [client, federation]
        compress: false

database:
  name: psycopg2
  args:
    user: synapse
    password: "${config.pgPassword}"
    database: synapse
    host: pg-${config.slug}
    port: 5432
    cp_min: 2
    cp_max: 5

media_store_path: /data/media_store
max_upload_size: 50M
url_preview_enabled: false

registration_shared_secret: "${config.registrationSecret}"

enable_registration: false
enable_registration_without_verification: false

report_stats: false

signing_key_path: /data/signing.key

trusted_key_servers: []

suppress_key_server_warning: true
${federationBlock}
log_config: "/data/log.config"
`.trim();
}

function renderLogConfig(): string {
  return `
version: 1
formatters:
  precise:
    format: '%(asctime)s - %(name)s - %(lineno)d - %(levelname)s - %(message)s'
handlers:
  console:
    class: logging.StreamHandler
    formatter: precise
loggers:
  synapse.storage.SQL:
    level: WARNING
root:
  level: WARNING
  handlers: [console]
disable_existing_loggers: false
`.trim();
}

function renderDockerCompose(config: TenantBoxConfig): string {
  const versions = resolveVersions(config);
  const networkName = `tb-${config.slug}`;

  return `
services:
  postgres:
    image: postgres:${versions.postgres}
    container_name: pg-${config.slug}
    hostname: pg-${config.slug}
    restart: unless-stopped
    environment:
      POSTGRES_DB: synapse
      POSTGRES_USER: synapse
      POSTGRES_PASSWORD: "${config.pgPassword}"
      POSTGRES_INITDB_ARGS: "--encoding=UTF8 --lc-collate=C --lc-ctype=C"
    command:
      - postgres
      - -c
      - shared_buffers=32MB
      - -c
      - max_connections=50
      - -c
      - effective_cache_size=128MB
    volumes:
      - ./postgres:/var/lib/postgresql/data
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U synapse"]
      interval: 10s
      timeout: 5s
      retries: 5
    networks:
      - ${networkName}

  minio:
    image: minio/minio:${versions.minio}
    container_name: minio-${config.slug}
    hostname: minio-${config.slug}
    restart: unless-stopped
    environment:
      MINIO_ROOT_USER: "${config.minioRootUser}"
      MINIO_ROOT_PASSWORD: "${config.minioRootPassword}"
    command: server /data
    volumes:
      - ./minio:/data
    ports:
      # Host-Port nur auf 127.0.0.1 — externer Zugriff via nginx
      - "127.0.0.1:${config.minioPort}:9000"
    healthcheck:
      test: ["CMD-SHELL", "mc ready local 2>/dev/null || curl -fs http://127.0.0.1:9000/minio/health/live"]
      interval: 15s
      timeout: 5s
      retries: 5
    networks:
      - ${networkName}

  synapse:
    image: matrixdotorg/synapse:v${versions.synapse}
    container_name: synapse-${config.slug}
    hostname: synapse-${config.slug}
    restart: unless-stopped
    depends_on:
      postgres:
        condition: service_healthy
      minio:
        condition: service_healthy
    ports:
      - "0.0.0.0:${config.synapsePort}:8008"
    volumes:
      - ./homeserver.yaml:/data/homeserver.yaml:ro
      - ./signing.key:/data/signing.key:ro
      - ./log.config:/data/log.config:ro
      - ./synapse/media_store:/data/media_store
    environment:
      - SYNAPSE_CONFIG_PATH=/data/homeserver.yaml
    mem_limit: 512m
    cpus: 0.5
    networks:
      - ${networkName}

networks:
  ${networkName}:
    name: ${networkName}
    driver: bridge
`.trim();
}

function renderManifest(config: TenantBoxConfig): string {
  const versions = resolveVersions(config);
  return JSON.stringify({
    schema_version: MANIFEST_SCHEMA_VERSION,
    tenant_slug: config.slug,
    domain: config.domain,
    server_name: config.serverName,
    public_baseurl: config.publicBaseUrl,
    tier: config.tier,
    stack: {
      synapse:  versions.synapse,
      postgres: versions.postgres,
      minio:    versions.minio,
    },
    ports: {
      synapse: config.synapsePort,
      minio:   config.minioPort,
    },
    last_updated: new Date().toISOString(),
    last_pre_update_snapshot: null,
  }, null, 2);
}

// ─── Schreibe Tenant-Verzeichnis ────────────────────────────────────────────

async function writeBoxDirectory(config: TenantBoxConfig): Promise<void> {
  const dir = tenantDir(config.slug);

  // Strukturierte Subdirs anlegen — werden von Volume-Mounts benötigt
  // BEVOR docker compose up läuft (sonst legt Docker root-owned Subdirs an).
  await fs.mkdir(dir, { recursive: true });
  await fs.mkdir(path.join(dir, 'postgres'), { recursive: true });
  await fs.mkdir(path.join(dir, 'minio'),    { recursive: true });
  await fs.mkdir(path.join(dir, 'synapse', 'media_store'), { recursive: true });

  // Postgres-Datadir braucht UID 70 (alpine postgres-User), Synapse media_store UID 991.
  // Setzen wir hier explizit, sonst kommt's beim ersten Container-Start zu Permission-
  // Errors die schwer zu debuggen sind.
  await safeExec('chown', ['-R', '70:70', path.join(dir, 'postgres')]);
  await safeExec('chown', ['-R', '991:991', path.join(dir, 'synapse', 'media_store')]);

  // Files
  await fs.writeFile(path.join(dir, 'docker-compose.yml'), renderDockerCompose(config), 'utf8');
  await fs.writeFile(path.join(dir, 'homeserver.yaml'),    renderHomeserverYaml(config), 'utf8');
  await fs.writeFile(path.join(dir, 'log.config'),         renderLogConfig(),            'utf8');
  await fs.writeFile(path.join(dir, 'manifest.json'),      renderManifest(config),       'utf8');

  const signingKey = config.signingKey ?? generateSigningKey();
  const signingKeyPath = path.join(dir, 'signing.key');
  await fs.writeFile(signingKeyPath, signingKey + '\n', { mode: 0o600 });
  // Synapse läuft als UID 991, muss signing.key lesen können — sonst
  // bootet der Container nicht ("Permission denied: /data/signing.key").
  // Das Setzen mit chown statt 0644 hält das Geheimnis vor anderen
  // Container-Usern verborgen.
  await safeExec('chown', ['991:991', signingKeyPath]);

  // Credentials separat — niemals in docker-compose.yml hardcoden für Audit-Zwecke
  const credsContent = `# Auto-generated — do not edit manually
PG_PASSWORD=${config.pgPassword}
MINIO_ROOT_USER=${config.minioRootUser}
MINIO_ROOT_PASSWORD=${config.minioRootPassword}
REGISTRATION_SECRET=${config.registrationSecret}
`;
  await fs.writeFile(path.join(dir, 'credentials.env'), credsContent, { mode: 0o600 });
}

// ─── nginx-Server-Block ─────────────────────────────────────────────────────

async function writeNginxConfig(config: TenantBoxConfig): Promise<void> {
  const wildcardCert = config.domain.endsWith('.prilog.team')
    ? '/etc/letsencrypt/live/wildcard.prilog.team'
    : `/etc/letsencrypt/live/${config.domain}`;

  const conf = `# Auto-generated by tenant-box.create — slug: ${config.slug}
server {
    listen 443 ssl http2;
    server_name ${config.domain};

    ssl_certificate     ${wildcardCert}/fullchain.pem;
    ssl_certificate_key ${wildcardCert}/privkey.pem;

    location /_matrix {
        proxy_pass http://127.0.0.1:${config.synapsePort};
        proxy_set_header X-Forwarded-For $remote_addr;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_set_header Host $host;
        client_max_body_size 50M;
    }

    location /_synapse/client {
        proxy_pass http://127.0.0.1:${config.synapsePort};
        proxy_set_header Host $host;
    }

    location /.well-known/matrix/server {
        default_type application/json;
        return 200 '{"m.server": "${config.serverName}:443"}';
    }

    location /.well-known/matrix/client {
        default_type application/json;
        add_header Access-Control-Allow-Origin *;
        return 200 '{"m.homeserver": {"base_url": "${config.publicBaseUrl}"}}';
    }

    location /storage/ {
        # Per-Tenant MinIO via 127.0.0.1:<minioPort>, nicht nach extern offen
        proxy_pass http://127.0.0.1:${config.minioPort}/;
        proxy_set_header Host $host;
        client_max_body_size 200m;
    }

    location /api/ {
        proxy_pass https://api.prilog.chat/api/;
        proxy_set_header Host api.prilog.chat;
        proxy_set_header X-Forwarded-For $remote_addr;
        proxy_set_header X-Real-Tenant ${config.domain};
        proxy_ssl_server_name on;
    }

    location ~ ^/tenant- {
        proxy_pass http://127.0.0.1:9000;
        proxy_set_header Host ${config.domain};
        client_max_body_size 200m;
    }

    location / {
        root /var/www/prilog-web-client;
        try_files $uri $uri/ /index.html;
    }
}

server {
    listen 80;
    server_name ${config.domain};
    return 301 https://$host$request_uri;
}
`;
  const target = `/etc/nginx/sites-available/${config.domain}.conf`;
  const link   = `/etc/nginx/sites-enabled/${config.domain}.conf`;
  await fs.writeFile(target, conf, 'utf8');
  // symlink — falls vorhanden, neu setzen
  await safeExec('ln', ['-sf', target, link]);
}

// ─── Handlers ───────────────────────────────────────────────────────────────

export async function handleTenantBoxCreate(
  commandId: string,
  args: Record<string, unknown>,
  send: SendFn,
): Promise<void> {
  const start = Date.now();
  let config: TenantBoxConfig;
  try {
    config = TenantBoxConfigSchema.parse(args?.config);
  } catch (err: any) {
    const msg = err?.issues
      ? err.issues.map((i: any) => `${i.path.join('.')}: ${i.message}`).join(', ')
      : (err?.message ?? String(err));
    reply(send, commandId, false, { error: `Config-Validierung fehlgeschlagen: ${msg}` });
    return;
  }

  logger.info(`[tenant-box] create ${config.slug} (synapse:${config.synapsePort}, minio:${config.minioPort})`);

  try {
    const dir = tenantDir(config.slug);

    // Idempotenz: wenn dir existiert + compose läuft, return early
    const exists = await fs.stat(dir).then(() => true).catch(() => false);
    if (exists) {
      const composeFile = path.join(dir, 'docker-compose.yml');
      const composeExists = await fs.stat(composeFile).then(() => true).catch(() => false);
      if (composeExists) {
        // Healthcheck — wenn schon up, einfach success melden
        const ps = await safeExec('docker', ['compose', '-f', composeFile, 'ps', '--format', 'json'], { ignoreExitCode: true });
        if (ps.stdout.includes('"State":"running"')) {
          reply(send, commandId, true, { result: { idempotent: true, message: 'Box bereits aktiv' } });
          return;
        }
      }
    }

    // 1. Verzeichnis + Files schreiben
    await writeBoxDirectory(config);

    // 2. Compose stack starten (postgres + minio + synapse mit depends_on healthcheck)
    await safeExec('docker', ['compose', '-f', path.join(dir, 'docker-compose.yml'), 'up', '-d']);

    // 3. Bucket im neuen MinIO anlegen via mc (wartet bis MinIO ready)
    //    Wir reichen MINIO_ROOT_PASSWORD über env, damit es nicht in Logs landet.
    const mcAlias = `tb-${config.slug}`;
    let bucketReady = false;
    for (let i = 0; i < 12; i++) {
      const aliasResult = await safeExec('mc', [
        'alias', 'set', mcAlias,
        `http://127.0.0.1:${config.minioPort}`,
        config.minioRootUser, config.minioRootPassword,
      ], { ignoreExitCode: true });
      if (aliasResult.exitCode === 0) {
        await safeExec('mc', ['mb', '--ignore-existing', `${mcAlias}/${config.minioBucket}`], { ignoreExitCode: true });
        bucketReady = true;
        break;
      }
      await new Promise(r => setTimeout(r, 5000));
    }
    if (!bucketReady) {
      logger.warn(`[tenant-box] MinIO-Bucket-Anlage nicht bestätigt für ${config.slug} — manuell prüfen`);
    }

    // 4. nginx-Block schreiben + reload
    await writeNginxConfig(config);
    await safeExec('nginx', ['-t']);
    await safeExec('systemctl', ['reload', 'nginx']);

    // 5. Health-Check Synapse — bis 120s warten (Synapse-DB-Init kann dauern)
    let healthy = false;
    for (let i = 0; i < 12; i++) {
      const r = await safeExec('curl', [
        '-fsS', '--max-time', '8',
        `http://127.0.0.1:${config.synapsePort}/_matrix/client/versions`,
      ], { ignoreExitCode: true });
      if (r.stdout.includes('versions') || r.stdout.includes('m.client')) {
        healthy = true;
        break;
      }
      await new Promise(r => setTimeout(r, 10_000));
    }

    if (!healthy) {
      reply(send, commandId, false, {
        error: 'Synapse antwortet nicht nach 120s',
        result: { partial: true, message: 'Stack läuft, aber Synapse antwortet nicht — manuell debuggen' },
      });
      return;
    }

    reply(send, commandId, true, {
      result: {
        slug: config.slug,
        synapsePort: config.synapsePort,
        minioPort:   config.minioPort,
        bucket:      config.minioBucket,
        bucketReady,
        healthy: true,
        durationMs: Date.now() - start,
      },
    });
  } catch (err: any) {
    logger.error(`[tenant-box] create failed: ${err?.message ?? err}`);
    reply(send, commandId, false, { error: String(err?.message ?? err) });
  }
}

export async function handleTenantBoxSnapshot(
  commandId: string,
  args: Record<string, unknown>,
  send: SendFn,
): Promise<void> {
  const slug = String(args.slug ?? '');
  if (!slug) {
    reply(send, commandId, false, { error: 'slug fehlt' });
    return;
  }
  const dir = tenantDir(slug);
  const composeFile = path.join(dir, 'docker-compose.yml');

  try {
    if (!await fs.stat(composeFile).then(() => true).catch(() => false)) {
      reply(send, commandId, false, { error: `tenant-box ${slug} existiert nicht (kein docker-compose.yml)` });
      return;
    }

    await fs.mkdir(SNAPSHOT_DIR, { recursive: true });
    const ts = new Date().toISOString().replace(/[:.]/g, '').replace(/\..+$/, '').replace('T', 'T');
    const snapshotPath = path.join(SNAPSHOT_DIR, `${slug}-${ts}.tar.gz`);

    // Pre-Snapshot: manifest.json mit aktuellen Versionen + Timestamp aktualisieren
    // (so dass der Tarball ein selbstbeschreibendes Manifest enthält)
    const manifestPath = path.join(dir, 'manifest.json');
    const manifest = JSON.parse(await fs.readFile(manifestPath, 'utf8'));
    manifest.snapshot_taken_at = new Date().toISOString();
    await fs.writeFile(manifestPath, JSON.stringify(manifest, null, 2), 'utf8');

    // Postgres clean stop (tar muss konsistente DB-Files sehen)
    await safeExec('docker', ['compose', '-f', composeFile, 'stop', 'postgres']);

    // tar mit pigz wenn vorhanden, sonst gzip
    const hasPigz = (await safeExec('which', ['pigz'], { ignoreExitCode: true })).exitCode === 0;
    if (hasPigz) {
      await safeExec('bash', ['-c', `tar -cf - -C ${dir} . | pigz -p 4 > ${snapshotPath}.tmp`]);
    } else {
      await safeExec('bash', ['-c', `tar -czf ${snapshotPath}.tmp -C ${dir} .`]);
    }

    // SHA256
    const shaResult = await safeExec('sha256sum', [`${snapshotPath}.tmp`]);
    const sha256 = shaResult.stdout.split(' ')[0];

    // atomic rename
    await safeExec('mv', [`${snapshotPath}.tmp`, snapshotPath]);

    // Postgres wieder starten
    await safeExec('docker', ['compose', '-f', composeFile, 'start', 'postgres']);

    const stat = await fs.stat(snapshotPath);
    reply(send, commandId, true, {
      result: {
        slug,
        snapshotPath,
        sha256,
        sizeBytes: stat.size,
        takenAt: new Date().toISOString(),
      },
    });
  } catch (err: any) {
    // Sicherstellen, dass postgres wieder läuft (auch wenn tar fehlschlug)
    await safeExec('docker', ['compose', '-f', composeFile, 'start', 'postgres'], { ignoreExitCode: true });
    reply(send, commandId, false, { error: String(err?.message ?? err) });
  }
}

export async function handleTenantBoxDestroy(
  commandId: string,
  args: Record<string, unknown>,
  send: SendFn,
): Promise<void> {
  const slug = String(args.slug ?? '');
  const purge = Boolean(args.purge);
  if (!slug) {
    reply(send, commandId, false, { error: 'slug fehlt' });
    return;
  }
  const dir = tenantDir(slug);
  const composeFile = path.join(dir, 'docker-compose.yml');

  try {
    // Compose down + (optional) volumes weg
    if (await fs.stat(composeFile).then(() => true).catch(() => false)) {
      const composeArgs = ['compose', '-f', composeFile, 'down'];
      if (purge) composeArgs.push('-v');
      await safeExec('docker', composeArgs, { ignoreExitCode: true });
    }

    if (purge) {
      // Verzeichnis komplett entfernen
      await safeExec('rm', ['-rf', dir]);
    }

    // nginx-Block entfernen — wenn vorhanden, mit slug zu identifizieren
    // Wir wissen die domain nicht zwingend, aber prüfen die files mit dem slug-Marker
    const sitesAvailable = '/etc/nginx/sites-available';
    const files = await fs.readdir(sitesAvailable).catch(() => [] as string[]);
    for (const f of files) {
      const filePath = path.join(sitesAvailable, f);
      const content = await fs.readFile(filePath, 'utf8').catch(() => '');
      if (content.includes(`tenant-box.create — slug: ${slug}`)) {
        await fs.unlink(filePath).catch(() => {});
        await fs.unlink(path.join('/etc/nginx/sites-enabled', f)).catch(() => {});
      }
    }
    await safeExec('systemctl', ['reload', 'nginx'], { ignoreExitCode: true });

    reply(send, commandId, true, { result: { slug, purged: purge } });
  } catch (err: any) {
    reply(send, commandId, false, { error: String(err?.message ?? err) });
  }
}

// ─── Import: Migration vom alten Layout (shared PG+MinIO) → Tenant-Box ──────
// Spezialisierter Handler für die one-time Migration der bestehenden Tenants
// (demo, demo2, demo3, leander). Nach Phase 4 nicht mehr benötigt.
//
// Ablauf (alle auf demselben Host — kein Cross-Host-Transfer):
//   1. signing.key vom alten Pfad lesen → invariant für Matrix-Identität
//   2. Snapshot der alten Daten in /tmp/import-<slug>/:
//      - dump.sql aus shared Postgres
//      - bucket/ aus shared MinIO
//      - media/ aus /var/lib/prilog/synapse-<slug>/
//   3. Alte synapse-<slug> Container stoppen + entfernen (Container-Name-
//      Konflikt mit neuer Box vermeiden). VOLUME bleibt für Rollback.
//   4. Tenant-Box anlegen (writeBoxDirectory) MIT alter signing.key
//   5. compose up postgres minio (synapse noch nicht!)
//   6. Daten importieren in pg-<slug> + minio-<slug>
//   7. media nach /srv/tenants/<slug>/synapse/media_store/ kopieren
//   8. compose up synapse → bootet mit imported DB
//   9. Verify
//   10. nginx-Block schreiben + reload
//
// Soak-Phase: alte DB im shared PG + alter Bucket bleiben 7 Tage als
// Rollback-Pfad. Cleanup-Job läuft separat.

const TenantBoxImportSchema = TenantBoxConfigSchema.extend({
  oldSynapseContainer: z.string().default(''),  // Default: synapse-<slug>
  oldDbName:           z.string(),               // z.B. synapse_demo3
  oldDbUser:           z.string(),               // z.B. synapse_demo3
  oldDbPassword:       z.string(),
  oldBucketName:       z.string(),               // z.B. tenant-demo3
  oldMediaPath:        z.string().default(''),   // Default: /var/lib/prilog/synapse-<slug>
  oldSigningKeyPath:   z.string().default(''),   // Default: /opt/prilog/tenants/<slug>/signing.key
});

export async function handleTenantBoxImport(
  commandId: string,
  args: Record<string, unknown>,
  send: SendFn,
): Promise<void> {
  const start = Date.now();
  let parsed: z.infer<typeof TenantBoxImportSchema>;
  try {
    parsed = TenantBoxImportSchema.parse(args?.config);
  } catch (err: any) {
    const msg = err?.issues
      ? err.issues.map((i: any) => `${i.path.join('.')}: ${i.message}`).join(', ')
      : (err?.message ?? String(err));
    reply(send, commandId, false, { error: `Config: ${msg}` });
    return;
  }

  const slug = parsed.slug;
  const oldSynapseContainer = parsed.oldSynapseContainer || `synapse-${slug}`;
  const oldMediaPath        = parsed.oldMediaPath        || `/var/lib/prilog/synapse-${slug}`;
  const oldSigningKeyPath   = parsed.oldSigningKeyPath   || `/opt/prilog/tenants/${slug}/signing.key`;

  logger.info(`[tenant-box] import ${slug} from shared layout (synapse:${parsed.synapsePort}, minio:${parsed.minioPort})`);

  const importStaging = `/tmp/import-${slug}-${Date.now()}`;
  const dir = tenantDir(slug);

  try {
    // 1. signing.key vom alten Pfad lesen — Invariante!
    const oldSigningKey = await fs.readFile(oldSigningKeyPath, 'utf8').catch(() => null);
    if (!oldSigningKey) {
      throw new Error(`Alte signing.key nicht gefunden unter ${oldSigningKeyPath} — Identität wäre nicht erhaltbar!`);
    }
    const config: TenantBoxConfig = {
      ...parsed,
      signingKey: oldSigningKey.trim(),
    };

    // 2. Staging-Dir + Snapshot der alten Daten
    await fs.mkdir(importStaging, { recursive: true });

    // 2a. pg_dump aus shared Postgres
    logger.info(`[tenant-box] import: pg_dump ${parsed.oldDbName}`);
    await safeExec('bash', ['-c',
      `sudo -u postgres pg_dump -Fc ${parsed.oldDbName} > ${importStaging}/dump.pgcustom`,
    ]);

    // 2b. mc mirror aus shared MinIO Bucket (alias 'local' siehe agent-Setup)
    logger.info(`[tenant-box] import: mc mirror ${parsed.oldBucketName}`);
    await fs.mkdir(`${importStaging}/bucket`, { recursive: true });
    await safeExec('bash', ['-c',
      `mc mirror --quiet local/${parsed.oldBucketName}/ ${importStaging}/bucket/ 2>&1 | tail -3`,
    ]);

    // 2c. Media-Files (kopieren später nach compose up — sonst chown-Stress)
    const mediaExists = await fs.stat(oldMediaPath).then(() => true).catch(() => false);

    // 2d. Pre-Flight: Sind die neuen Ports wirklich frei?
    //     Vorher (bis 2026-05-02) haben wir den alten Container gestoppt
    //     BEVOR wir den Port checkten — bei Konflikt war der Tenant dann
    //     offline während wir auf den Bug stießen. Jetzt FAIL-FAST hier.
    const portUsed = await safeExec('bash', ['-c',
      `ss -tlnp 2>/dev/null | grep -E ':${parsed.synapsePort}\\s' || true`,
    ], { ignoreExitCode: true });
    if (portUsed.stdout.trim() && !portUsed.stdout.includes(`synapse-${slug}`)) {
      throw new Error(`Port ${parsed.synapsePort} ist bereits belegt: ${portUsed.stdout.trim().slice(0, 200)} — Migration abgebrochen, alter Container noch online.`);
    }
    const minioPortUsed = await safeExec('bash', ['-c',
      `ss -tlnp 2>/dev/null | grep -E ':${parsed.minioPort}\\s' || true`,
    ], { ignoreExitCode: true });
    if (minioPortUsed.stdout.trim()) {
      throw new Error(`MinIO-Port ${parsed.minioPort} bereits belegt: ${minioPortUsed.stdout.trim().slice(0, 200)} — Migration abgebrochen, alter Container noch online.`);
    }

    // 3. Alten Synapse-Container stoppen + entfernen (nicht das Volume!)
    logger.info(`[tenant-box] import: stoppe alten Container ${oldSynapseContainer}`);
    await safeExec('docker', ['stop', oldSynapseContainer], { ignoreExitCode: true });
    await safeExec('docker', ['rm', oldSynapseContainer], { ignoreExitCode: true });

    // (Downtime beginnt hier — User-Anfragen bekommen 502)

    // 4. Neue Box-Files schreiben
    await writeBoxDirectory(config);

    // 5. Nur postgres + minio starten (synapse noch NICHT — DB muss erst importiert werden)
    const composeFile = path.join(dir, 'docker-compose.yml');
    await safeExec('docker', ['compose', '-f', composeFile, 'up', '-d', 'postgres', 'minio']);

    // 5b. Auf postgres + minio healthy warten (max 60s)
    let pgReady = false, minioReady = false;
    for (let i = 0; i < 12; i++) {
      const pgState = await safeExec('docker', ['inspect', '--format', '{{.State.Health.Status}}', `pg-${slug}`], { ignoreExitCode: true });
      const minioState = await safeExec('docker', ['inspect', '--format', '{{.State.Health.Status}}', `minio-${slug}`], { ignoreExitCode: true });
      pgReady = pgState.stdout.trim() === 'healthy';
      minioReady = minioState.stdout.trim() === 'healthy';
      if (pgReady && minioReady) break;
      await new Promise(r => setTimeout(r, 5000));
    }
    if (!pgReady || !minioReady) {
      throw new Error(`postgres oder minio nicht healthy nach 60s (pg=${pgReady}, minio=${minioReady})`);
    }

    // 6a. PG-Restore in den NEUEN postgres-Container
    logger.info(`[tenant-box] import: pg_restore in pg-${slug}`);
    await safeExec('bash', ['-c',
      `cat ${importStaging}/dump.pgcustom | docker exec -i pg-${slug} pg_restore -U synapse -d synapse --no-owner --no-acl`,
    ], { ignoreExitCode: true });
    // pg_restore kann harmlose Warnings ausgeben (Owner ändert sich) — ignoreExitCode

    // 6b. mc mirror in NEUE MinIO
    logger.info(`[tenant-box] import: mc mirror → minio-${slug}`);
    const mcAlias = `tb-${slug}`;
    let mcReady = false;
    for (let i = 0; i < 12; i++) {
      const r = await safeExec('mc', [
        'alias', 'set', mcAlias,
        `http://127.0.0.1:${config.minioPort}`,
        config.minioRootUser, config.minioRootPassword,
      ], { ignoreExitCode: true });
      if (r.exitCode === 0) { mcReady = true; break; }
      await new Promise(r => setTimeout(r, 3000));
    }
    if (!mcReady) {
      throw new Error('mc alias konnte nicht gesetzt werden für neue MinIO');
    }
    await safeExec('mc', ['mb', '--ignore-existing', `${mcAlias}/${config.minioBucket}`], { ignoreExitCode: true });
    const bucketSize = await safeExec('bash', ['-c', `find ${importStaging}/bucket -type f | wc -l`]);
    if (parseInt(bucketSize.stdout.trim(), 10) > 0) {
      await safeExec('bash', ['-c',
        `mc mirror --quiet ${importStaging}/bucket/ ${mcAlias}/${config.minioBucket}/ 2>&1 | tail -3`,
      ]);
    }

    // 7. Media-Files kopieren (synapse media_store)
    if (mediaExists) {
      logger.info(`[tenant-box] import: copy media`);
      const targetMedia = path.join(dir, 'synapse', 'media_store');
      // -a: preserve attributes, --no-target-directory: kopiere INHALT, nicht den Folder
      await safeExec('bash', ['-c', `cp -aT ${oldMediaPath} ${targetMedia}`], { ignoreExitCode: true });
      await safeExec('chown', ['-R', '991:991', targetMedia]);
    }

    // 8. Synapse jetzt starten
    logger.info(`[tenant-box] import: starte synapse`);
    await safeExec('docker', ['compose', '-f', composeFile, 'up', '-d', 'synapse']);

    // 9. Health-Check (max 120s)
    let healthy = false;
    for (let i = 0; i < 12; i++) {
      const r = await safeExec('curl', [
        '-fsS', '--max-time', '8',
        `http://127.0.0.1:${config.synapsePort}/_matrix/client/versions`,
      ], { ignoreExitCode: true });
      if (r.stdout.includes('versions') || r.stdout.includes('m.client')) { healthy = true; break; }
      await new Promise(r => setTimeout(r, 10_000));
    }

    if (!healthy) {
      reply(send, commandId, false, {
        error: 'Synapse antwortet nicht nach 120s — Import angefangen aber unvollständig. Manuell prüfen.',
        result: { partial: true, importStaging },
      });
      return;
    }

    // 10. nginx-Block + reload
    await writeNginxConfig(config);
    await safeExec('nginx', ['-t']);
    await safeExec('systemctl', ['reload', 'nginx']);

    // 11. Staging-Dir aufräumen — Daten sind im neuen Stack drin
    await safeExec('rm', ['-rf', importStaging], { ignoreExitCode: true });

    reply(send, commandId, true, {
      result: {
        slug,
        synapsePort: config.synapsePort,
        minioPort: config.minioPort,
        healthy: true,
        durationMs: Date.now() - start,
        message: `Import OK. Old DB ${parsed.oldDbName} + bucket ${parsed.oldBucketName} bleiben 7 Tage als Rollback-Pfad.`,
      },
    });
  } catch (err: any) {
    logger.error(`[tenant-box] import failed: ${err?.message ?? err}`);
    // Staging-Dir behalten — Operator kann manuell weiter machen
    reply(send, commandId, false, { error: String(err?.message ?? err), result: { importStaging } });
  }
}
