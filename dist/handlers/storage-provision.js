"use strict";
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
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.provisionStorageServiceAccount = provisionStorageServiceAccount;
const child_process_1 = require("child_process");
const util_1 = require("util");
const logger_js_1 = require("../utils/logger.js");
const execFileP = (0, util_1.promisify)(child_process_1.execFile);
// Alias-Name in der mc-Config — auf allen Customer-Servern als 'local' gesetzt.
const MC_ALIAS = process.env.MINIO_MC_ALIAS || 'local';
async function mc(args) {
    // --disable-pager: mc oeffnet sonst less/more, was bei execFile haengt.
    // --no-color:      verhindert ANSI-Escapes in stdout (saubere Regex-Parses).
    // --quiet:         keine Progress-Bar.
    return execFileP('mc', ['--disable-pager', '--no-color', '--quiet', ...args], { timeout: 30000 });
}
async function ensureBucket(bucket) {
    logger_js_1.logger.info(`[storage-provision] ensureBucket starting: ${bucket}`);
    try {
        const r = await mc(['mb', `${MC_ALIAS}/${bucket}`, '--ignore-existing']);
        logger_js_1.logger.info(`[storage-provision] ensureBucket done: ${bucket}`, { stdoutLen: r.stdout.length });
    }
    catch (err) {
        logger_js_1.logger.error('[storage-provision] mc mb fehlgeschlagen', { err: err.message, bucket });
        throw new Error(`Bucket ${bucket} konnte nicht angelegt werden: ${err.message}`);
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
async function createServiceAccount(bucket, description) {
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
    const fs = await Promise.resolve().then(() => __importStar(require('fs/promises')));
    const path = await Promise.resolve().then(() => __importStar(require('path')));
    const tmpDir = await fs.mkdtemp(path.join('/tmp', 'svcacct-'));
    const policyPath = path.join(tmpDir, 'policy.json');
    await fs.writeFile(policyPath, policy);
    // Parent-User: der MinIO-Account, unter dem der Service-Account haengt.
    // Default ist der MinIO-Root-User des jeweiligen Servers.
    const parentUser = process.env.MINIO_PARENT_USER || 'minioadmin';
    try {
        logger_js_1.logger.info(`[storage-provision] svcacct add starting`, { bucket, parentUser });
        const { stdout, stderr } = await mc([
            'admin', 'user', 'svcacct', 'add',
            MC_ALIAS, parentUser,
            '--policy', policyPath,
            '--description', description,
        ]);
        logger_js_1.logger.info(`[storage-provision] svcacct add done`, { stdoutLen: stdout.length, stderrLen: stderr.length });
        const accessMatch = /Access Key:\s*(\S+)/i.exec(stdout);
        const secretMatch = /Secret Key:\s*(\S+)/i.exec(stdout);
        if (!accessMatch || !secretMatch) {
            throw new Error(`mc-Ausgabe konnte nicht geparst werden:\n${stdout}`);
        }
        return { accessKey: accessMatch[1], secretKey: secretMatch[1] };
    }
    finally {
        await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => { });
    }
}
/**
 * Endpoint, den das Backend fuer S3-Client-Initialisierung nutzt.
 * Wir nehmen die offizielle Domain mit dem Nginx-Pfad, damit der Browser
 * (presigned URL) direkt darauf zugreifen kann.
 *
 * Hostname kommt aus MATRIX_DOMAIN (Standard-Env in prilog-agent-systemd-Unit).
 */
function buildEndpoint() {
    const domain = process.env.MATRIX_DOMAIN
        || process.env.AGENT_DOMAIN
        || process.env.HOSTNAME_FQDN
        || process.env.HOSTNAME
        || 'localhost';
    return `https://${domain}/s3`;
}
async function provisionStorageServiceAccount(args) {
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
