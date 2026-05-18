"use strict";
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
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.handleTenantBoxCreate = handleTenantBoxCreate;
exports.handleTenantBoxRewriteNginx = handleTenantBoxRewriteNginx;
exports.handleTenantBoxUpdate = handleTenantBoxUpdate;
exports.handleTenantBoxReportVersions = handleTenantBoxReportVersions;
exports.handleTenantBoxHealthcheck = handleTenantBoxHealthcheck;
exports.handleTenantBoxSnapshot = handleTenantBoxSnapshot;
exports.handleTenantBoxDestroy = handleTenantBoxDestroy;
exports.handleLegacyCleanup = handleLegacyCleanup;
exports.handleTenantBoxBackup = handleTenantBoxBackup;
exports.handleTenantBoxRestore = handleTenantBoxRestore;
exports.handleTenantBoxImport = handleTenantBoxImport;
const node_fs_1 = require("node:fs");
const node_path_1 = __importDefault(require("node:path"));
const zod_1 = require("zod");
const safe_exec_js_1 = require("../provision/engine/safe-exec.js");
const logger_js_1 = require("../utils/logger.js");
// ─── Konstanten ─────────────────────────────────────────────────────────────
const TENANT_BOX_ROOT = '/srv/tenants';
const SNAPSHOT_DIR = '/var/lib/prilog/snapshots';
const MANIFEST_SCHEMA_VERSION = 1;
// Der prilog_matrix_connector ist KEIN pip-Paket im Synapse-Image — er wird
// als Quellverzeichnis in den Container gemountet (PYTHONPATH). Ohne diesen
// Mount crasht Synapse beim Start im Crash-Loop, sobald der modules:-Block
// in homeserver.yaml das Modul referenziert (rssw-Incident 2026-05-18).
// Die Source ist mit dem Agent GEBÜNDELT (assets/) → kein Netz/Git nötig,
// funktioniert deterministisch für jeden künftigen Tenant. Pfad relativ zur
// kompilierten Datei: dist/handlers/tenant-box.js → <repo>/assets/...
const BUNDLED_CONNECTOR_DIR = node_path_1.default.resolve(__dirname, '../../assets/prilog-matrix-connector');
const CONNECTOR_CONTAINER_DIR = '/modules/prilog-matrix-connector';
// Default-Versionen — werden langfristig vom Backend überschrieben (Version-
// Registry, siehe Konzept Sektion 4). Hier nur Fallback.
//
// Wichtig: synapse muss zur DB-Schema-Version passen! Bei Import alter Tenants
// erwarten wir das Schema von synapse:latest (was im Shared-Deployment lief).
// Mit einer älteren Version kämen unbekannte Tabellen aus dem dump und Synapse
// würde diese ignorieren oder das Schema neu initialisieren — Daten werden
// dann nicht angezeigt (siehe demo3-Import 2026-05-02).
const DEFAULT_VERSIONS = {
    synapse: 'latest',
    // Postgres muss MINDESTENS so neu sein wie der Shared-Host-Postgres,
    // sonst kann pg_restore das Dump-Format nicht lesen ("unsupported
    // version 1.15 in file header" — gesehen 2026-05-02 mit pg-15
    // gegen Source-pg-16). Shared-Host läuft heute pg-16, daher 16-alpine.
    postgres: '16-alpine',
    minio: 'RELEASE.2024-12-13T22-19-12Z',
};
// ─── Config Schema ──────────────────────────────────────────────────────────
const TenantBoxConfigSchema = zod_1.z.object({
    // Identität
    slug: zod_1.z.string().regex(/^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/),
    domain: zod_1.z.string(), // <slug>.prilog.team oder chat.firma.com
    serverName: zod_1.z.string(), // Matrix server_name — invariant über Lifecycle, meist <slug>.prilog.team
    publicBaseUrl: zod_1.z.string(), // https://<domain>/
    // Ports (auf Host-Ebene)
    synapsePort: zod_1.z.number().int().min(8100).max(8299),
    minioPort: zod_1.z.number().int().min(9100).max(9299), // 127.0.0.1-bound, nginx proxy von extern
    // Postgres
    pgPassword: zod_1.z.string().min(16),
    // MinIO. min(3) entspricht MinIO's eigener Anforderung.
    // Vorher min(8): scheiterte bei kurzen Slugs wie "demo" (tb-demo = 7 chars).
    minioRootUser: zod_1.z.string().min(3),
    minioRootPassword: zod_1.z.string().min(16),
    minioBucket: zod_1.z.string().default('default'),
    // Synapse
    registrationSecret: zod_1.z.string().min(16),
    signingKey: zod_1.z.string().optional(), // wenn vorhanden: bestehende Identität (z.B. bei Migration)
    // Versions (optional — sonst DEFAULT_VERSIONS)
    versions: zod_1.z.object({
        synapse: zod_1.z.string().optional(),
        postgres: zod_1.z.string().optional(),
        minio: zod_1.z.string().optional(),
    }).optional(),
    // Tier (für spätere Federation-Disable, Resource-Limits)
    tier: zod_1.z.enum(['free', 'pro', 'enterprise']).default('pro'),
    // Admin-User wird nach erstem Synapse-Boot via /_synapse/admin/v1/register
    // angelegt (HMAC gegen registrationSecret). Optional — wenn nicht gesetzt,
    // wird kein Admin-User erstellt (z.B. bei Migration alter Tenants kommt
    // der bereits aus dem importierten DB-Dump).
    adminUsername: zod_1.z.string().nullish(),
    adminPassword: zod_1.z.string().nullish(),
});
// ─── Helpers ────────────────────────────────────────────────────────────────
function reply(send, commandId, success, payload = {}) {
    send('agent.command_result', { commandId, success, ...payload });
}
function tenantDir(slug) {
    return node_path_1.default.join(TENANT_BOX_ROOT, slug);
}
function resolveVersions(config) {
    return {
        synapse: config.versions?.synapse ?? DEFAULT_VERSIONS.synapse,
        postgres: config.versions?.postgres ?? DEFAULT_VERSIONS.postgres,
        minio: config.versions?.minio ?? DEFAULT_VERSIONS.minio,
    };
}
function generateSigningKey() {
    const id = `a_${Math.random().toString(36).slice(2, 10)}`;
    const data = Buffer.from(Array.from({ length: 32 }, () => Math.floor(Math.random() * 256))).toString('base64');
    return `ed25519 ${id} ${data}`;
}
// ─── Template-Rendering ─────────────────────────────────────────────────────
function renderHomeserverYaml(config) {
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
function renderLogConfig() {
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
function renderDockerCompose(config) {
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
    image: matrixdotorg/synapse:${versions.synapse}
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
      - ./connectors/prilog-matrix-connector:${CONNECTOR_CONTAINER_DIR}:ro
    environment:
      - SYNAPSE_CONFIG_PATH=/data/homeserver.yaml
      - PYTHONPATH=${CONNECTOR_CONTAINER_DIR}/src
      - PYTHONUNBUFFERED=1
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
function renderManifest(config) {
    const versions = resolveVersions(config);
    return JSON.stringify({
        schema_version: MANIFEST_SCHEMA_VERSION,
        tenant_slug: config.slug,
        domain: config.domain,
        server_name: config.serverName,
        public_baseurl: config.publicBaseUrl,
        tier: config.tier,
        stack: {
            synapse: versions.synapse,
            postgres: versions.postgres,
            minio: versions.minio,
        },
        ports: {
            synapse: config.synapsePort,
            minio: config.minioPort,
        },
        last_updated: new Date().toISOString(),
        last_pre_update_snapshot: null,
    }, null, 2);
}
// ─── Schreibe Tenant-Verzeichnis ────────────────────────────────────────────
async function writeBoxDirectory(config) {
    const dir = tenantDir(config.slug);
    // Strukturierte Subdirs anlegen — werden von Volume-Mounts benötigt
    // BEVOR docker compose up läuft (sonst legt Docker root-owned Subdirs an).
    await node_fs_1.promises.mkdir(dir, { recursive: true });
    await node_fs_1.promises.mkdir(node_path_1.default.join(dir, 'postgres'), { recursive: true });
    await node_fs_1.promises.mkdir(node_path_1.default.join(dir, 'minio'), { recursive: true });
    await node_fs_1.promises.mkdir(node_path_1.default.join(dir, 'synapse', 'media_store'), { recursive: true });
    // Postgres-Datadir braucht UID 70 (alpine postgres-User), Synapse media_store UID 991.
    // Setzen wir hier explizit, sonst kommt's beim ersten Container-Start zu Permission-
    // Errors die schwer zu debuggen sind.
    await (0, safe_exec_js_1.safeExec)('chown', ['-R', '70:70', node_path_1.default.join(dir, 'postgres')]);
    await (0, safe_exec_js_1.safeExec)('chown', ['-R', '991:991', node_path_1.default.join(dir, 'synapse', 'media_store')]);
    // Connector-Source pro Tenant ablegen (Mount-Ziel ./connectors/...).
    // MUSS vor `docker compose up` liegen, sonst legt Synapse einen leeren
    // root-owned Mount an und crasht (ModuleNotFound → Crash-Loop). Quelle
    // ist mit dem Agent gebündelt — fehlt sie, ist der Agent-Build kaputt:
    // laut scheitern statt eine login-untaugliche Box auszuliefern.
    if (!(0, node_fs_1.existsSync)(node_path_1.default.join(BUNDLED_CONNECTOR_DIR, 'src', 'prilog_matrix_connector', 'module.py'))) {
        throw new Error(`Gebündelte Connector-Source fehlt: ${BUNDLED_CONNECTOR_DIR} — Agent-Deploy unvollständig (assets/ nicht ausgeliefert)`);
    }
    await node_fs_1.promises.mkdir(node_path_1.default.join(dir, 'connectors'), { recursive: true });
    await (0, safe_exec_js_1.safeExec)('cp', ['-a', BUNDLED_CONNECTOR_DIR, node_path_1.default.join(dir, 'connectors') + '/']);
    // Files
    await node_fs_1.promises.writeFile(node_path_1.default.join(dir, 'docker-compose.yml'), renderDockerCompose(config), 'utf8');
    await node_fs_1.promises.writeFile(node_path_1.default.join(dir, 'homeserver.yaml'), renderHomeserverYaml(config), 'utf8');
    await node_fs_1.promises.writeFile(node_path_1.default.join(dir, 'log.config'), renderLogConfig(), 'utf8');
    await node_fs_1.promises.writeFile(node_path_1.default.join(dir, 'manifest.json'), renderManifest(config), 'utf8');
    const signingKey = config.signingKey ?? generateSigningKey();
    const signingKeyPath = node_path_1.default.join(dir, 'signing.key');
    await node_fs_1.promises.writeFile(signingKeyPath, signingKey + '\n', { mode: 0o600 });
    // Synapse läuft als UID 991, muss signing.key lesen können — sonst
    // bootet der Container nicht ("Permission denied: /data/signing.key").
    // Das Setzen mit chown statt 0644 hält das Geheimnis vor anderen
    // Container-Usern verborgen.
    await (0, safe_exec_js_1.safeExec)('chown', ['991:991', signingKeyPath]);
    // Credentials separat — niemals in docker-compose.yml hardcoden für Audit-Zwecke
    const credsContent = `# Auto-generated — do not edit manually
PG_PASSWORD=${config.pgPassword}
MINIO_ROOT_USER=${config.minioRootUser}
MINIO_ROOT_PASSWORD=${config.minioRootPassword}
REGISTRATION_SECRET=${config.registrationSecret}
`;
    await node_fs_1.promises.writeFile(node_path_1.default.join(dir, 'credentials.env'), credsContent, { mode: 0o600 });
}
// ─── nginx-Server-Block ─────────────────────────────────────────────────────
async function writeNginxConfig(config) {
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

    # Per-Tenant MinIO. WICHTIG: KEIN Path-Strip - AWS Signature V4 signiert
    # die volle URL inkl. Bucket-Name. Wenn nginx das /storage/-Prefix
    # strippt (proxy_pass mit trailing /), errechnet MinIO eine andere
    # Signatur als der SDK signiert hat -> SignatureDoesNotMatch (403).
    # Daher: Bucket = tenant-<slug>, URL = /tenant-<slug>/..., SDK-Endpoint
    # = https://<domain> (ohne /storage), Pfad-Identitaet zwischen SDK + MinIO.
    location /tenant-${config.slug}/ {
        proxy_pass http://127.0.0.1:${config.minioPort};
        proxy_set_header Host $host;
        client_max_body_size 200m;
    }
    # Backwards-compat: /default/ ist der alte Bucket-Name fuer Tenants die
    # vor dem Bucket-Rename provisioniert wurden. Endpunkt ist dann auch
    # https://<domain> (ohne /storage), genau wie beim neuen Schema.
    location /default/ {
        proxy_pass http://127.0.0.1:${config.minioPort};
        proxy_set_header Host $host;
        client_max_body_size 200m;
    }
    # Legacy /storage/ — fuer evtl. noch nicht-migrierten Code (kann spaeter raus).
    location /storage/ {
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
    const link = `/etc/nginx/sites-enabled/${config.domain}.conf`;
    await node_fs_1.promises.writeFile(target, conf, 'utf8');
    // symlink — falls vorhanden, neu setzen
    await (0, safe_exec_js_1.safeExec)('ln', ['-sf', target, link]);
}
// ─── Handlers ───────────────────────────────────────────────────────────────
async function handleTenantBoxCreate(commandId, args, send) {
    const start = Date.now();
    let config;
    try {
        config = TenantBoxConfigSchema.parse(args?.config);
    }
    catch (err) {
        const msg = err?.issues
            ? err.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join(', ')
            : (err?.message ?? String(err));
        reply(send, commandId, false, { error: `Config-Validierung fehlgeschlagen: ${msg}` });
        return;
    }
    logger_js_1.logger.info(`[tenant-box] create ${config.slug} (synapse:${config.synapsePort}, minio:${config.minioPort})`);
    try {
        const dir = tenantDir(config.slug);
        // Idempotenz: wenn dir existiert + compose läuft, return early
        const exists = await node_fs_1.promises.stat(dir).then(() => true).catch(() => false);
        if (exists) {
            const composeFile = node_path_1.default.join(dir, 'docker-compose.yml');
            const composeExists = await node_fs_1.promises.stat(composeFile).then(() => true).catch(() => false);
            if (composeExists) {
                // Healthcheck — wenn schon up, einfach success melden
                const ps = await (0, safe_exec_js_1.safeExec)('docker', ['compose', '-f', composeFile, 'ps', '--format', 'json'], { ignoreExitCode: true });
                if (ps.stdout.includes('"State":"running"')) {
                    reply(send, commandId, true, { result: { idempotent: true, message: 'Box bereits aktiv' } });
                    return;
                }
            }
        }
        // 1. Verzeichnis + Files schreiben
        await writeBoxDirectory(config);
        // 2. Compose stack starten (postgres + minio + synapse mit depends_on healthcheck)
        await (0, safe_exec_js_1.safeExec)('docker', ['compose', '-f', node_path_1.default.join(dir, 'docker-compose.yml'), 'up', '-d']);
        // 3. Bucket im neuen MinIO anlegen via mc (wartet bis MinIO ready)
        //    Wir reichen MINIO_ROOT_PASSWORD über env, damit es nicht in Logs landet.
        const mcAlias = `tb-${config.slug}`;
        let bucketReady = false;
        for (let i = 0; i < 12; i++) {
            const aliasResult = await (0, safe_exec_js_1.safeExec)('mc', [
                'alias', 'set', mcAlias,
                `http://127.0.0.1:${config.minioPort}`,
                config.minioRootUser, config.minioRootPassword,
            ], { ignoreExitCode: true });
            if (aliasResult.exitCode === 0) {
                await (0, safe_exec_js_1.safeExec)('mc', ['mb', '--ignore-existing', `${mcAlias}/${config.minioBucket}`], { ignoreExitCode: true });
                bucketReady = true;
                break;
            }
            await new Promise(r => setTimeout(r, 5000));
        }
        if (!bucketReady) {
            logger_js_1.logger.warn(`[tenant-box] MinIO-Bucket-Anlage nicht bestätigt für ${config.slug} — manuell prüfen`);
        }
        // 4. nginx-Block schreiben + reload
        await writeNginxConfig(config);
        await (0, safe_exec_js_1.safeExec)('nginx', ['-t']);
        await (0, safe_exec_js_1.safeExec)('systemctl', ['reload', 'nginx']);
        // 5. Health-Check Synapse — bis 120s warten (Synapse-DB-Init kann dauern)
        let healthy = false;
        for (let i = 0; i < 12; i++) {
            const r = await (0, safe_exec_js_1.safeExec)('curl', [
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
        // 6. Admin-User über Synapse Admin-API registrieren (wenn angegeben)
        let adminCreated = false;
        if (config.adminUsername && config.adminPassword) {
            try {
                const nonceRes = await (0, safe_exec_js_1.safeExec)('curl', ['-sf', `http://127.0.0.1:${config.synapsePort}/_synapse/admin/v1/register`]);
                const nonce = JSON.parse(nonceRes.stdout).nonce;
                const crypto = await Promise.resolve().then(() => __importStar(require('node:crypto')));
                const hmac = crypto.createHmac('sha1', config.registrationSecret);
                hmac.update(nonce);
                hmac.update('\0');
                hmac.update(config.adminUsername);
                hmac.update('\0');
                hmac.update(config.adminPassword);
                hmac.update('\0');
                hmac.update('admin');
                const mac = hmac.digest('hex');
                const regBody = JSON.stringify({
                    nonce, username: config.adminUsername, password: config.adminPassword, admin: true, mac,
                });
                await (0, safe_exec_js_1.safeExec)('curl', [
                    '-sf', '-X', 'POST',
                    `http://127.0.0.1:${config.synapsePort}/_synapse/admin/v1/register`,
                    '-H', 'Content-Type: application/json',
                    '-d', regBody,
                ]);
                adminCreated = true;
                logger_js_1.logger.info(`[tenant-box] admin-user @${config.adminUsername} angelegt`);
            }
            catch (err) {
                logger_js_1.logger.warn(`[tenant-box] admin-user-Erstellung fehlgeschlagen: ${err?.message ?? err}`);
            }
        }
        reply(send, commandId, true, {
            result: {
                slug: config.slug,
                synapsePort: config.synapsePort,
                minioPort: config.minioPort,
                bucket: config.minioBucket,
                bucketReady,
                adminCreated,
                healthy: true,
                durationMs: Date.now() - start,
            },
        });
    }
    catch (err) {
        logger_js_1.logger.error(`[tenant-box] create failed: ${err?.message ?? err}`);
        reply(send, commandId, false, { error: String(err?.message ?? err) });
    }
}
/**
 * Schreibt nur die nginx-Konfiguration der Tenant-Box neu + reload.
 * Nuetzlich nach Agent-Update mit geaenderten nginx-Templates, ohne den
 * Stack neu zu starten. Idempotent.
 */
async function handleTenantBoxRewriteNginx(commandId, args, send) {
    const slug = String(args.slug ?? '');
    if (!slug) {
        reply(send, commandId, false, { error: 'slug fehlt' });
        return;
    }
    const dir = tenantDir(slug);
    const manifestPath = node_path_1.default.join(dir, 'manifest.json');
    try {
        const stat = await node_fs_1.promises.stat(manifestPath).catch(() => null);
        if (!stat) {
            reply(send, commandId, false, { error: `manifest.json fuer ${slug} nicht gefunden` });
            return;
        }
        const manifest = JSON.parse(await node_fs_1.promises.readFile(manifestPath, 'utf8'));
        // Manifest verwendet snake_case (siehe renderManifest in tenant-box.ts).
        // Mapping auf TenantBoxConfig (camelCase) — nur Felder die writeNginxConfig braucht.
        const ports = (manifest.ports ?? {});
        const config = TenantBoxConfigSchema.parse({
            slug: manifest.tenant_slug ?? manifest.slug,
            domain: manifest.domain,
            serverName: manifest.server_name ?? manifest.serverName,
            publicBaseUrl: manifest.public_baseurl ?? manifest.publicBaseUrl,
            synapsePort: ports.synapse ?? manifest.synapsePort,
            minioPort: ports.minio ?? manifest.minioPort,
            // Dummy-Werte fuer required-Felder im Schema — werden bei rewrite_nginx
            // nicht benoetigt (writeNginxConfig nutzt nur slug/domain/serverName/
            // publicBaseUrl/synapsePort/minioPort).
            pgPassword: 'unused-rewrite-placeholder-1234567890',
            minioRootUser: 'unused-rewrite',
            minioRootPassword: 'unused-rewrite-placeholder-1234567890',
            minioBucket: 'unused-rewrite',
            registrationSecret: 'unused-rewrite-placeholder-1234567890-abcdef-123456789',
            signingKey: 'ed25519 a_unused_unused_unused_unused_unused_unused_unused_unused',
            tier: manifest.tier ?? 'pro',
        });
        await writeNginxConfig(config);
        await (0, safe_exec_js_1.safeExec)('nginx', ['-t']);
        await (0, safe_exec_js_1.safeExec)('systemctl', ['reload', 'nginx']);
        reply(send, commandId, true, { result: { slug, message: 'nginx-Block neu geschrieben + reload OK' } });
    }
    catch (err) {
        logger_js_1.logger.error(`[tenant-box] rewrite_nginx failed: ${err?.message ?? err}`);
        reply(send, commandId, false, { error: String(err?.message ?? err) });
    }
}
// ─── Update: docker compose Image-Tag-Bump + Restart ─────────────────────
//
// Pre-Snapshot wird NICHT hier gemacht — das Backend triggert vorher
// tenant-box.backup mit tier='pre-update'. Dieser Handler macht nur den
// eigentlichen Compose-Bump.
//
// Args:
//   slug:     'demo'
//   versions: { synapse?: string; postgres?: string; minio?: string }
//             — nur die Komponenten die geaendert werden sollen
//
// Schritte:
//   1. compose-File lesen, image-Tags der relevanten Services ersetzen
//   2. compose pull (zieht neue Images)
//   3. compose up -d (recreate nur die Services die sich geaendert haben)
//   4. Reply mit fromVersions / toVersions
//
// Kein Health-Check hier — das macht das Backend mit separatem Healthcheck.
// Kein Auto-Rollback hier — das macht das Backend mit restoreBackup wenn
// der Healthcheck fehlschlaegt.
async function handleTenantBoxUpdate(commandId, args, send) {
    const slug = String(args.slug ?? '');
    const versions = (args.versions ?? {});
    if (!slug) {
        reply(send, commandId, false, { error: 'slug fehlt' });
        return;
    }
    const dir = tenantDir(slug);
    const composeFile = node_path_1.default.join(dir, 'docker-compose.yml');
    try {
        const compose = await node_fs_1.promises.readFile(composeFile, 'utf8').catch(() => null);
        if (!compose) {
            reply(send, commandId, false, { error: `tenant-box ${slug} existiert nicht` });
            return;
        }
        // Alte Versionen aus dem compose-File extrahieren (regex statt YAML-Parser
        // damit wir Format-Treue beim Schreiben haben)
        const extract = (service, repo) => {
            // matched: image: <repo>:<tag>  innerhalb von   <service>:\n ... image:
            const re = new RegExp(`(\\b${service}:\\s*\\n[\\s\\S]*?image:\\s*${repo}:)([^\\s]+)`, 'm');
            const m = compose.match(re);
            return m?.[2] ?? null;
        };
        const fromVersions = {
            synapse: extract('synapse', 'matrixdotorg/synapse'),
            postgres: extract('postgres', 'postgres'),
            minio: extract('minio', 'minio/minio'),
        };
        let updated = compose;
        const changedServices = [];
        if (versions.synapse && versions.synapse !== fromVersions.synapse) {
            const re = new RegExp(`(\\bsynapse:\\s*\\n[\\s\\S]*?image:\\s*matrixdotorg/synapse:)([^\\s]+)`, 'm');
            updated = updated.replace(re, `$1${versions.synapse}`);
            changedServices.push('synapse');
        }
        if (versions.postgres && versions.postgres !== fromVersions.postgres) {
            const re = new RegExp(`(\\bpostgres:\\s*\\n[\\s\\S]*?image:\\s*postgres:)([^\\s]+)`, 'm');
            updated = updated.replace(re, `$1${versions.postgres}`);
            changedServices.push('postgres');
        }
        if (versions.minio && versions.minio !== fromVersions.minio) {
            const re = new RegExp(`(\\bminio:\\s*\\n[\\s\\S]*?image:\\s*minio/minio:)([^\\s]+)`, 'm');
            updated = updated.replace(re, `$1${versions.minio}`);
            changedServices.push('minio');
        }
        if (changedServices.length === 0) {
            reply(send, commandId, true, {
                result: { slug, fromVersions, toVersions: fromVersions, changedServices: [], idempotent: true },
            });
            return;
        }
        // Backup des compose-Files (so dass Backend bei Bedarf manuell zurueckwerfen kann)
        await node_fs_1.promises.writeFile(`${composeFile}.before-update.${Date.now()}`, compose, 'utf8');
        await node_fs_1.promises.writeFile(composeFile, updated, 'utf8');
        // Pull der neuen Images
        const pull = await (0, safe_exec_js_1.safeExec)('docker', ['compose', '-f', composeFile, 'pull', ...changedServices], { ignoreExitCode: true });
        if (pull.exitCode !== 0) {
            // Pull failed → compose-File zurueckschreiben damit nichts halbes liegt
            await node_fs_1.promises.writeFile(composeFile, compose, 'utf8');
            reply(send, commandId, false, {
                error: `docker compose pull failed: ${pull.stderr || pull.stdout}`,
                rolledBackComposeFile: true,
            });
            return;
        }
        // Up -d wird NUR die geaenderten Services neu starten (compose erkennt
        // image-Diff). Mit --no-deps damit andere Services nicht angefasst werden.
        // Allerdings wuerden Postgres-Updates Synapse-Restart erzwingen, das ist OK.
        const start = Date.now();
        const up = await (0, safe_exec_js_1.safeExec)('docker', [
            'compose', '-f', composeFile, 'up', '-d',
            ...changedServices,
        ]);
        if (up.exitCode !== 0) {
            reply(send, commandId, false, { error: `docker compose up failed: ${up.stderr || up.stdout}` });
            return;
        }
        reply(send, commandId, true, {
            result: {
                slug,
                fromVersions,
                toVersions: { ...fromVersions, ...versions },
                changedServices,
                durationMs: Date.now() - start,
            },
        });
    }
    catch (err) {
        logger_js_1.logger.error(`[tenant-box] update failed for ${slug}: ${err?.message ?? err}`);
        reply(send, commandId, false, { error: String(err?.message ?? err) });
    }
}
// ─── Live Version Scan + Healthcheck (Phase 6 Update-Pipeline, Stufe 4) ───
//
// Diese zwei Handler liefern Read-only-Daten ueber den aktuellen Zustand
// einer Tenant-Box. Werden vom Drift-Detection-Cron + von der Update-
// Pipeline aufgerufen. Keine State-Aenderung.
async function handleTenantBoxReportVersions(commandId, args, send) {
    const slug = String(args.slug ?? '');
    if (!slug) {
        reply(send, commandId, false, { error: 'slug fehlt' });
        return;
    }
    const dir = tenantDir(slug);
    const composeFile = node_path_1.default.join(dir, 'docker-compose.yml');
    try {
        if (!await node_fs_1.promises.stat(composeFile).then(() => true).catch(() => false)) {
            reply(send, commandId, false, { error: `tenant-box ${slug} existiert nicht` });
            return;
        }
        // docker compose ps --format json gibt eine Liste der laufenden
        // Services mit Image-Tags zurueck. Wir extrahieren Synapse / Postgres
        // / MinIO. Image-Format ist typisch <repo>:<tag>, wir nehmen den Teil
        // nach dem Doppelpunkt.
        const ps = await (0, safe_exec_js_1.safeExec)('docker', [
            'compose', '-f', composeFile, 'ps', '--format', 'json', '--all',
        ], { ignoreExitCode: true });
        if (ps.exitCode !== 0) {
            reply(send, commandId, false, { error: `docker compose ps failed: ${ps.stderr || ps.stdout}` });
            return;
        }
        // docker compose ps --format json gibt eine NDJSON-Liste pro Zeile
        // (eine JSON-Object pro Service). Manche Versionen liefern auch ein
        // einzelnes JSON-Array — wir handhaben beides.
        const services = [];
        const trimmed = ps.stdout.trim();
        if (trimmed.startsWith('[')) {
            try {
                services.push(...JSON.parse(trimmed));
            }
            catch { /* ignore */ }
        }
        else {
            for (const line of trimmed.split('\n')) {
                if (!line.trim())
                    continue;
                try {
                    services.push(JSON.parse(line));
                }
                catch { /* skip malformed */ }
            }
        }
        const findImage = (serviceName) => {
            const svc = services.find(s => s.Service === serviceName);
            if (!svc?.Image)
                return null;
            // <repo>:<tag> — splitte am letzten Doppelpunkt (repos koennen ports enthalten)
            const colonIdx = svc.Image.lastIndexOf(':');
            if (colonIdx < 0)
                return svc.Image;
            const tagPart = svc.Image.slice(colonIdx + 1);
            // Falls digest (sha256:...) angehaengt: nur den Tag vor dem @ nehmen
            const atIdx = tagPart.indexOf('@');
            return atIdx >= 0 ? tagPart.slice(0, atIdx) : tagPart;
        };
        const findStatus = (serviceName) => {
            const svc = services.find(s => s.Service === serviceName);
            return svc?.State ?? null;
        };
        reply(send, commandId, true, {
            result: {
                slug,
                versions: {
                    synapse: findImage('synapse'),
                    postgres: findImage('postgres'),
                    minio: findImage('minio'),
                },
                states: {
                    synapse: findStatus('synapse'),
                    postgres: findStatus('postgres'),
                    minio: findStatus('minio'),
                },
                scannedAt: new Date().toISOString(),
            },
        });
    }
    catch (err) {
        logger_js_1.logger.error(`[tenant-box] report_versions failed for ${slug}: ${err?.message ?? err}`);
        reply(send, commandId, false, { error: String(err?.message ?? err) });
    }
}
async function handleTenantBoxHealthcheck(commandId, args, send) {
    const slug = String(args.slug ?? '');
    const synapsePort = Number(args.synapsePort);
    const minioPort = Number(args.minioPort);
    if (!slug || !Number.isFinite(synapsePort) || !Number.isFinite(minioPort)) {
        reply(send, commandId, false, { error: 'slug + synapsePort + minioPort required' });
        return;
    }
    const dir = tenantDir(slug);
    const composeFile = node_path_1.default.join(dir, 'docker-compose.yml');
    try {
        if (!await node_fs_1.promises.stat(composeFile).then(() => true).catch(() => false)) {
            reply(send, commandId, false, { error: `tenant-box ${slug} existiert nicht` });
            return;
        }
        const checks = [];
        // 1. Synapse /_matrix/client/versions (auf 127.0.0.1:port)
        {
            const start = Date.now();
            const r = await (0, safe_exec_js_1.safeExec)('curl', [
                '-sS', '--max-time', '5', '-o', '/dev/null', '-w', '%{http_code}',
                `http://127.0.0.1:${synapsePort}/_matrix/client/versions`,
            ], { ignoreExitCode: true });
            const code = r.stdout.trim();
            checks.push({
                component: 'synapse_api',
                ok: code === '200',
                durationMs: Date.now() - start,
                detail: code === '200' ? undefined : `http=${code}`,
            });
        }
        // 2. Synapse /_matrix/client/v3/sync as proxy for sync-loop liveness
        //    (eigentlich braucht's einen Login fuer 200 — wir akzeptieren auch
        //    401/403 als "Synapse antwortet richtig", nur 5xx ist fail)
        {
            const start = Date.now();
            const r = await (0, safe_exec_js_1.safeExec)('curl', [
                '-sS', '--max-time', '5', '-o', '/dev/null', '-w', '%{http_code}',
                `http://127.0.0.1:${synapsePort}/_matrix/client/v3/sync?timeout=0`,
            ], { ignoreExitCode: true });
            const code = parseInt(r.stdout.trim(), 10);
            const ok = !isNaN(code) && code >= 200 && code < 500; // 401/403 ok
            checks.push({
                component: 'synapse_sync',
                ok,
                durationMs: Date.now() - start,
                detail: ok ? undefined : `http=${r.stdout.trim()}`,
            });
        }
        // 3. Postgres-Connection ueber den Compose-Container (psql -c 'SELECT 1')
        {
            const start = Date.now();
            const r = await (0, safe_exec_js_1.safeExec)('docker', [
                'compose', '-f', composeFile, 'exec', '-T', 'postgres',
                'pg_isready', '-U', 'synapse', '-d', 'synapse',
            ], { ignoreExitCode: true });
            checks.push({
                component: 'postgres',
                ok: r.exitCode === 0,
                durationMs: Date.now() - start,
                detail: r.exitCode === 0 ? undefined : (r.stderr || r.stdout || `exit=${r.exitCode}`).slice(0, 200),
            });
        }
        // 4. MinIO /minio/health/live
        {
            const start = Date.now();
            const r = await (0, safe_exec_js_1.safeExec)('curl', [
                '-sS', '--max-time', '5', '-o', '/dev/null', '-w', '%{http_code}',
                `http://127.0.0.1:${minioPort}/minio/health/live`,
            ], { ignoreExitCode: true });
            const code = r.stdout.trim();
            checks.push({
                component: 'minio',
                ok: code === '200',
                durationMs: Date.now() - start,
                detail: code === '200' ? undefined : `http=${code}`,
            });
        }
        const allOk = checks.every(c => c.ok);
        reply(send, commandId, true, {
            result: {
                slug,
                ok: allOk,
                checks,
                checkedAt: new Date().toISOString(),
            },
        });
    }
    catch (err) {
        logger_js_1.logger.error(`[tenant-box] healthcheck failed for ${slug}: ${err?.message ?? err}`);
        reply(send, commandId, false, { error: String(err?.message ?? err) });
    }
}
async function handleTenantBoxSnapshot(commandId, args, send) {
    const slug = String(args.slug ?? '');
    if (!slug) {
        reply(send, commandId, false, { error: 'slug fehlt' });
        return;
    }
    const dir = tenantDir(slug);
    const composeFile = node_path_1.default.join(dir, 'docker-compose.yml');
    try {
        if (!await node_fs_1.promises.stat(composeFile).then(() => true).catch(() => false)) {
            reply(send, commandId, false, { error: `tenant-box ${slug} existiert nicht (kein docker-compose.yml)` });
            return;
        }
        await node_fs_1.promises.mkdir(SNAPSHOT_DIR, { recursive: true });
        const ts = new Date().toISOString().replace(/[:.]/g, '').replace(/\..+$/, '').replace('T', 'T');
        const snapshotPath = node_path_1.default.join(SNAPSHOT_DIR, `${slug}-${ts}.tar.gz`);
        // Pre-Snapshot: manifest.json mit aktuellen Versionen + Timestamp aktualisieren
        // (so dass der Tarball ein selbstbeschreibendes Manifest enthält)
        const manifestPath = node_path_1.default.join(dir, 'manifest.json');
        const manifest = JSON.parse(await node_fs_1.promises.readFile(manifestPath, 'utf8'));
        manifest.snapshot_taken_at = new Date().toISOString();
        await node_fs_1.promises.writeFile(manifestPath, JSON.stringify(manifest, null, 2), 'utf8');
        // Postgres clean stop (tar muss konsistente DB-Files sehen)
        await (0, safe_exec_js_1.safeExec)('docker', ['compose', '-f', composeFile, 'stop', 'postgres']);
        // tar mit pigz wenn vorhanden, sonst gzip
        const hasPigz = (await (0, safe_exec_js_1.safeExec)('which', ['pigz'], { ignoreExitCode: true })).exitCode === 0;
        if (hasPigz) {
            await (0, safe_exec_js_1.safeExec)('bash', ['-c', `tar -cf - -C ${dir} . | pigz -p 4 > ${snapshotPath}.tmp`]);
        }
        else {
            await (0, safe_exec_js_1.safeExec)('bash', ['-c', `tar -czf ${snapshotPath}.tmp -C ${dir} .`]);
        }
        // SHA256
        const shaResult = await (0, safe_exec_js_1.safeExec)('sha256sum', [`${snapshotPath}.tmp`]);
        const sha256 = shaResult.stdout.split(' ')[0];
        // atomic rename
        await (0, safe_exec_js_1.safeExec)('mv', [`${snapshotPath}.tmp`, snapshotPath]);
        // Postgres wieder starten
        await (0, safe_exec_js_1.safeExec)('docker', ['compose', '-f', composeFile, 'start', 'postgres']);
        const stat = await node_fs_1.promises.stat(snapshotPath);
        reply(send, commandId, true, {
            result: {
                slug,
                snapshotPath,
                sha256,
                sizeBytes: stat.size,
                takenAt: new Date().toISOString(),
            },
        });
    }
    catch (err) {
        // Sicherstellen, dass postgres wieder läuft (auch wenn tar fehlschlug)
        await (0, safe_exec_js_1.safeExec)('docker', ['compose', '-f', composeFile, 'start', 'postgres'], { ignoreExitCode: true });
        reply(send, commandId, false, { error: String(err?.message ?? err) });
    }
}
async function handleTenantBoxDestroy(commandId, args, send) {
    const slug = String(args.slug ?? '');
    const purge = Boolean(args.purge);
    if (!slug) {
        reply(send, commandId, false, { error: 'slug fehlt' });
        return;
    }
    const dir = tenantDir(slug);
    const composeFile = node_path_1.default.join(dir, 'docker-compose.yml');
    try {
        // Compose down + (optional) volumes weg
        if (await node_fs_1.promises.stat(composeFile).then(() => true).catch(() => false)) {
            const composeArgs = ['compose', '-f', composeFile, 'down'];
            if (purge)
                composeArgs.push('-v');
            await (0, safe_exec_js_1.safeExec)('docker', composeArgs, { ignoreExitCode: true });
        }
        if (purge) {
            // Verzeichnis komplett entfernen
            await (0, safe_exec_js_1.safeExec)('rm', ['-rf', dir]);
        }
        // nginx-Block entfernen — wenn vorhanden, mit slug zu identifizieren
        // Wir wissen die domain nicht zwingend, aber prüfen die files mit dem slug-Marker
        const sitesAvailable = '/etc/nginx/sites-available';
        const files = await node_fs_1.promises.readdir(sitesAvailable).catch(() => []);
        for (const f of files) {
            const filePath = node_path_1.default.join(sitesAvailable, f);
            const content = await node_fs_1.promises.readFile(filePath, 'utf8').catch(() => '');
            if (content.includes(`tenant-box.create — slug: ${slug}`)) {
                await node_fs_1.promises.unlink(filePath).catch(() => { });
                await node_fs_1.promises.unlink(node_path_1.default.join('/etc/nginx/sites-enabled', f)).catch(() => { });
            }
        }
        await (0, safe_exec_js_1.safeExec)('systemctl', ['reload', 'nginx'], { ignoreExitCode: true });
        reply(send, commandId, true, { result: { slug, purged: purge } });
    }
    catch (err) {
        reply(send, commandId, false, { error: String(err?.message ?? err) });
    }
}
// ─── Legacy-Cleanup: alte Shared-Architektur-Reste entfernen ───────────────
// Wird vom Tenant-Lifecycle-Service (Backend) aufgerufen wenn ein Tenant
// gelöscht wird. Räumt das auf was tenant-box.destroy nicht abdeckt:
//   - synapse_<slug> DB im shared Postgres (auf dem Host)
//   - tenant-<slug> Bucket im shared MinIO
//   - /opt/prilog/tenants/<slug>/ alte compose-files
//   - synapse-<slug> Container falls noch da (z.B. wenn Tenant nie migriert wurde)
//   - synapse-data-<slug> docker volume
//   - /etc/nginx/sites-enabled/<domain>.conf alte nginx-blöcke
async function handleLegacyCleanup(commandId, args, send) {
    const slug = String(args.slug ?? '');
    const domain = String(args.domain ?? `${slug}.prilog.team`);
    if (!slug) {
        reply(send, commandId, false, { error: 'slug required' });
        return;
    }
    const cleaned = [];
    const skipped = [];
    // 1. Container stoppen+entfernen falls noch da
    const containerCheck = await (0, safe_exec_js_1.safeExec)('docker', ['ps', '-a', '--format', '{{.Names}}', '--filter', `name=synapse-${slug}`], { ignoreExitCode: true });
    if (containerCheck.stdout.trim()) {
        await (0, safe_exec_js_1.safeExec)('docker', ['stop', `synapse-${slug}`], { ignoreExitCode: true });
        await (0, safe_exec_js_1.safeExec)('docker', ['rm', `synapse-${slug}`], { ignoreExitCode: true });
        cleaned.push(`container synapse-${slug}`);
    }
    else {
        skipped.push('container (already gone)');
    }
    // 2. Docker named volume
    const volumeName = `${slug}_synapse-data-${slug}`;
    const volumeCheck = await (0, safe_exec_js_1.safeExec)('docker', ['volume', 'ls', '--format', '{{.Name}}', '--filter', `name=${volumeName}`], { ignoreExitCode: true });
    if (volumeCheck.stdout.includes(volumeName)) {
        await (0, safe_exec_js_1.safeExec)('docker', ['volume', 'rm', volumeName], { ignoreExitCode: true });
        cleaned.push(`volume ${volumeName}`);
    }
    else {
        skipped.push('volume (already gone)');
    }
    // 3. Shared Postgres-DB droppen
    const dbName = `synapse_${slug}`;
    const dbUser = `synapse_${slug}`;
    const dbCheck = await (0, safe_exec_js_1.safeExec)('bash', ['-c',
        `sudo -u postgres psql -tAc "SELECT 1 FROM pg_database WHERE datname='${dbName}'"`,
    ], { ignoreExitCode: true });
    if (dbCheck.stdout.trim() === '1') {
        await (0, safe_exec_js_1.safeExec)('bash', ['-c', `sudo -u postgres dropdb --if-exists ${dbName}`], { ignoreExitCode: true });
        await (0, safe_exec_js_1.safeExec)('bash', ['-c', `sudo -u postgres dropuser --if-exists ${dbUser}`], { ignoreExitCode: true });
        cleaned.push(`shared-pg DB ${dbName}`);
    }
    else {
        skipped.push('shared-pg DB (already gone)');
    }
    // 4. Shared MinIO-Bucket entfernen
    const bucketName = `tenant-${slug}`;
    const bucketCheck = await (0, safe_exec_js_1.safeExec)('mc', ['ls', `local/${bucketName}`], { ignoreExitCode: true });
    if (bucketCheck.exitCode === 0) {
        await (0, safe_exec_js_1.safeExec)('mc', ['rb', '--force', `local/${bucketName}`], { ignoreExitCode: true });
        cleaned.push(`shared-minio bucket ${bucketName}`);
    }
    else {
        skipped.push('shared-minio bucket (already gone)');
    }
    // 5. /opt/prilog/tenants/<slug>/ — alte compose-files
    const oldDir = `/opt/prilog/tenants/${slug}`;
    if (await node_fs_1.promises.stat(oldDir).then(() => true).catch(() => false)) {
        await (0, safe_exec_js_1.safeExec)('rm', ['-rf', oldDir], { ignoreExitCode: true });
        cleaned.push(`dir ${oldDir}`);
    }
    else {
        skipped.push('old dir (already gone)');
    }
    // 6. nginx sites-enabled
    const nginxConf = `/etc/nginx/sites-enabled/${domain}.conf`;
    if (await node_fs_1.promises.stat(nginxConf).then(() => true).catch(() => false)) {
        await node_fs_1.promises.unlink(nginxConf).catch(() => { });
        await node_fs_1.promises.unlink(`/etc/nginx/sites-available/${domain}.conf`).catch(() => { });
        await (0, safe_exec_js_1.safeExec)('systemctl', ['reload', 'nginx'], { ignoreExitCode: true });
        cleaned.push(`nginx ${domain}.conf`);
    }
    else {
        skipped.push('nginx conf (already gone)');
    }
    reply(send, commandId, true, { result: { slug, cleaned, skipped } });
}
// ─── Backup: Snapshot + Encrypt + Upload zu S3 (Object Storage) ────────────
// Ablauf:
//   1. Postgres clean-stop (atomar)
//   2. tar -czf von /srv/tenants/<slug>/
//   3. Postgres wieder starten (Tenant ist sofort wieder schreibfähig)
//   4. SHA256 berechnen
//   5. AES-256-CBC encrypt mit per-tenant-key (vom Backend übergeben)
//   6. mc cp zu Hetzner Object Storage
//   7. lokales tarball + .enc löschen
//   8. return { sizeBytes, sha256, bucketKey }
async function handleTenantBoxBackup(commandId, args, send) {
    const slug = String(args.slug ?? '');
    const backupId = Number(args.backupId);
    const encryptionKeyHex = String(args.encryptionKeyHex ?? '');
    const s3 = args.s3;
    if (!slug || !Number.isFinite(backupId) || !encryptionKeyHex || encryptionKeyHex.length !== 64 || !s3) {
        reply(send, commandId, false, { error: 'slug + backupId + encryptionKeyHex (64 chars) + s3 config required' });
        return;
    }
    const dir = tenantDir(slug);
    const composeFile = node_path_1.default.join(dir, 'docker-compose.yml');
    if (!await node_fs_1.promises.stat(composeFile).then(() => true).catch(() => false)) {
        reply(send, commandId, false, { error: `tenant-box ${slug} existiert nicht` });
        return;
    }
    await node_fs_1.promises.mkdir(SNAPSHOT_DIR, { recursive: true });
    const ts = new Date().toISOString().replace(/[:.]/g, '').replace(/\..+$/, '').replace('T', 'T');
    const tarballLocal = node_path_1.default.join(SNAPSHOT_DIR, `${slug}-${ts}.tar.gz`);
    const encLocal = `${tarballLocal}.enc`;
    const start = Date.now();
    let pgStopped = false;
    try {
        // 1. Postgres stop
        await (0, safe_exec_js_1.safeExec)('docker', ['compose', '-f', composeFile, 'stop', 'postgres']);
        pgStopped = true;
        // 2. tar (mit pigz wenn da, sonst gzip)
        const hasPigz = (await (0, safe_exec_js_1.safeExec)('which', ['pigz'], { ignoreExitCode: true })).exitCode === 0;
        if (hasPigz) {
            await (0, safe_exec_js_1.safeExec)('bash', ['-c', `tar -cf - -C ${dir} . | pigz -p 4 > ${tarballLocal}`]);
        }
        else {
            await (0, safe_exec_js_1.safeExec)('bash', ['-c', `tar -czf ${tarballLocal} -C ${dir} .`]);
        }
        // 3. Postgres wieder hoch (Tenant ist wieder schreibfähig)
        await (0, safe_exec_js_1.safeExec)('docker', ['compose', '-f', composeFile, 'start', 'postgres']);
        pgStopped = false;
        // 4. SHA256 vom UNVERSCHLÜSSELTEN tarball (das ist was Restore verifizieren wird)
        const shaResult = await (0, safe_exec_js_1.safeExec)('sha256sum', [tarballLocal]);
        const sha256 = shaResult.stdout.split(/\s+/)[0];
        // 5. Encrypt mit AES-256-CBC + PBKDF2 — der key ist HKDF-derived per-tenant
        //    vom Backend (HKDF von BACKUP_MASTER_KEY + slug)
        await (0, safe_exec_js_1.safeExec)('bash', ['-c',
            `openssl enc -aes-256-cbc -salt -pbkdf2 -iter 100000 -in ${tarballLocal} -out ${encLocal} -pass pass:${encryptionKeyHex}`,
        ]);
        // 6. mc alias setzen + upload
        const mcAlias = `tb-backup-${slug}`;
        await (0, safe_exec_js_1.safeExec)('mc', [
            'alias', 'set', mcAlias, s3.endpoint, s3.accessKeyId, s3.secretAccessKey, '--api', 'S3v4',
        ]);
        await (0, safe_exec_js_1.safeExec)('mc', ['cp', '--quiet', encLocal, `${mcAlias}/${s3.bucket}/${s3.key}`]);
        // 7. Größe ermitteln + cleanup
        const stat = await node_fs_1.promises.stat(encLocal);
        await (0, safe_exec_js_1.safeExec)('rm', ['-f', tarballLocal, encLocal]);
        await (0, safe_exec_js_1.safeExec)('mc', ['alias', 'remove', mcAlias], { ignoreExitCode: true });
        reply(send, commandId, true, {
            result: {
                slug, backupId,
                sizeBytes: stat.size,
                sha256, // SHA256 des plaintext-tarball — wird beim Restore nach decrypt verifiziert
                bucketKey: s3.key,
                durationMs: Date.now() - start,
            },
        });
    }
    catch (err) {
        // Sicherstellen dass postgres läuft auch wenn was fehlschlug
        if (pgStopped) {
            await (0, safe_exec_js_1.safeExec)('docker', ['compose', '-f', composeFile, 'start', 'postgres'], { ignoreExitCode: true });
        }
        // Cleanup local files
        await (0, safe_exec_js_1.safeExec)('rm', ['-f', tarballLocal, encLocal], { ignoreExitCode: true });
        logger_js_1.logger.error(`[tenant-box] backup failed for ${slug}: ${err?.message ?? err}`);
        reply(send, commandId, false, { error: String(err?.message ?? err) });
    }
}
// ─── Restore: Download + Decrypt + Untar + Compose up ──────────────────────
// Ablauf:
//   1. Falls Tenant-Box existiert: stop + remove (compose down -v)
//   2. Download .enc vom S3
//   3. Decrypt mit per-tenant-key
//   4. SHA256 verify gegen erwarteten Wert
//   5. /srv/tenants/<slug>/ extrahieren
//   6. compose up postgres minio (warten bis healthy)
//   7. compose up synapse
//   8. Verify Synapse-Health
//   9. nginx-Block + reload
async function handleTenantBoxRestore(commandId, args, send) {
    const slug = String(args.slug ?? '');
    const expectedSha256 = String(args.expectedSha256 ?? '');
    const encryptionKeyHex = String(args.encryptionKeyHex ?? '');
    const s3 = args.s3;
    const inPlace = args.inPlace !== false; // default true: replace existing
    if (!slug || !expectedSha256 || !encryptionKeyHex || encryptionKeyHex.length !== 64 || !s3) {
        reply(send, commandId, false, { error: 'slug + expectedSha256 + encryptionKeyHex + s3 required' });
        return;
    }
    const dir = tenantDir(slug);
    const stagingDir = `/tmp/restore-${slug}-${Date.now()}`;
    const encDownload = `${stagingDir}/restored.tar.gz.enc`;
    const tarballDownload = `${stagingDir}/restored.tar.gz`;
    const start = Date.now();
    try {
        await node_fs_1.promises.mkdir(stagingDir, { recursive: true });
        // 1. Existierende Box runterfahren + Verzeichnis aufräumen (in-place restore)
        if (inPlace) {
            const composeFile = node_path_1.default.join(dir, 'docker-compose.yml');
            if (await node_fs_1.promises.stat(composeFile).then(() => true).catch(() => false)) {
                await (0, safe_exec_js_1.safeExec)('docker', ['compose', '-f', composeFile, 'down', '-v'], { ignoreExitCode: true });
            }
            await (0, safe_exec_js_1.safeExec)('rm', ['-rf', dir], { ignoreExitCode: true });
        }
        // 2. Download
        const mcAlias = `tb-restore-${slug}`;
        await (0, safe_exec_js_1.safeExec)('mc', [
            'alias', 'set', mcAlias, s3.endpoint, s3.accessKeyId, s3.secretAccessKey, '--api', 'S3v4',
        ]);
        await (0, safe_exec_js_1.safeExec)('mc', ['cp', '--quiet', `${mcAlias}/${s3.bucket}/${s3.key}`, encDownload]);
        // 3. Decrypt
        await (0, safe_exec_js_1.safeExec)('bash', ['-c',
            `openssl enc -d -aes-256-cbc -pbkdf2 -iter 100000 -in ${encDownload} -out ${tarballDownload} -pass pass:${encryptionKeyHex}`,
        ]);
        // 4. SHA256 verify
        const shaResult = await (0, safe_exec_js_1.safeExec)('sha256sum', [tarballDownload]);
        const actualSha256 = shaResult.stdout.split(/\s+/)[0];
        if (actualSha256 !== expectedSha256) {
            throw new Error(`SHA256-Mismatch! Expected ${expectedSha256}, got ${actualSha256} — Backup ist möglicherweise korrupt oder Encryption-Key falsch.`);
        }
        // 5. Extrahieren
        await node_fs_1.promises.mkdir(dir, { recursive: true });
        await (0, safe_exec_js_1.safeExec)('tar', ['-xzf', tarballDownload, '-C', dir]);
        // 6. Volume-Permissions
        await (0, safe_exec_js_1.safeExec)('chown', ['-R', '70:70', node_path_1.default.join(dir, 'postgres')], { ignoreExitCode: true });
        await (0, safe_exec_js_1.safeExec)('chown', ['-R', '991:991', node_path_1.default.join(dir, 'synapse', 'media_store')], { ignoreExitCode: true });
        await (0, safe_exec_js_1.safeExec)('chown', ['991:991', node_path_1.default.join(dir, 'signing.key')], { ignoreExitCode: true });
        // 7. Compose up
        const composeFile = node_path_1.default.join(dir, 'docker-compose.yml');
        await (0, safe_exec_js_1.safeExec)('docker', ['compose', '-f', composeFile, 'up', '-d', 'postgres', 'minio']);
        // Wait healthy
        let pgReady = false, minioReady = false;
        for (let i = 0; i < 12; i++) {
            const pg = await (0, safe_exec_js_1.safeExec)('docker', ['inspect', '--format', '{{.State.Health.Status}}', `pg-${slug}`], { ignoreExitCode: true });
            const mi = await (0, safe_exec_js_1.safeExec)('docker', ['inspect', '--format', '{{.State.Health.Status}}', `minio-${slug}`], { ignoreExitCode: true });
            pgReady = pg.stdout.trim() === 'healthy';
            minioReady = mi.stdout.trim() === 'healthy';
            if (pgReady && minioReady)
                break;
            await new Promise(r => setTimeout(r, 5000));
        }
        if (!pgReady || !minioReady) {
            throw new Error(`postgres oder minio nicht healthy nach 60s (pg=${pgReady}, minio=${minioReady})`);
        }
        // 8. Synapse starten + verify
        await (0, safe_exec_js_1.safeExec)('docker', ['compose', '-f', composeFile, 'up', '-d', 'synapse']);
        // Manifest lesen für port + domain
        const manifest = JSON.parse(await node_fs_1.promises.readFile(node_path_1.default.join(dir, 'manifest.json'), 'utf8'));
        const synapsePort = manifest.ports?.synapse ?? 8100;
        const domain = manifest.domain;
        let healthy = false;
        for (let i = 0; i < 18; i++) { // 3 min — Synapse-DB-Init kann nach Restore länger dauern
            const r = await (0, safe_exec_js_1.safeExec)('curl', [
                '-fsS', '--max-time', '8',
                `http://127.0.0.1:${synapsePort}/_matrix/client/versions`,
            ], { ignoreExitCode: true });
            if (r.stdout.includes('versions')) {
                healthy = true;
                break;
            }
            await new Promise(r => setTimeout(r, 10_000));
        }
        if (!healthy) {
            throw new Error(`Synapse antwortet nicht nach 180s — Restore war techn. erfolgreich aber Container startet nicht. Manuell debuggen.`);
        }
        // 9. nginx — Server-Block ist im Tarball nicht, wird hier neu generiert
        const config = {
            slug,
            domain,
            serverName: manifest.server_name,
            publicBaseUrl: manifest.public_baseurl,
            synapsePort,
            minioPort: manifest.ports?.minio ?? 9100,
            pgPassword: 'unused-restore', // wird von writeNginxConfig nicht gebraucht
            minioRootUser: 'unused',
            minioRootPassword: 'unused-pw',
            registrationSecret: 'unused',
            tier: manifest.tier ?? 'pro',
            minioBucket: 'default',
        };
        await writeNginxConfig(config);
        await (0, safe_exec_js_1.safeExec)('nginx', ['-t']);
        await (0, safe_exec_js_1.safeExec)('systemctl', ['reload', 'nginx']);
        // Cleanup
        await (0, safe_exec_js_1.safeExec)('rm', ['-rf', stagingDir], { ignoreExitCode: true });
        await (0, safe_exec_js_1.safeExec)('mc', ['alias', 'remove', mcAlias], { ignoreExitCode: true });
        reply(send, commandId, true, {
            result: {
                slug,
                synapsePort,
                domain,
                healthy: true,
                durationMs: Date.now() - start,
            },
        });
    }
    catch (err) {
        logger_js_1.logger.error(`[tenant-box] restore failed for ${slug}: ${err?.message ?? err}`);
        // Staging behalten für Debug
        reply(send, commandId, false, { error: String(err?.message ?? err), result: { stagingDir } });
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
    oldSynapseContainer: zod_1.z.string().default(''), // Default: synapse-<slug>
    oldDbName: zod_1.z.string(), // z.B. synapse_demo3
    oldDbUser: zod_1.z.string(), // z.B. synapse_demo3
    oldDbPassword: zod_1.z.string(),
    oldBucketName: zod_1.z.string(), // z.B. tenant-demo3
    oldMediaPath: zod_1.z.string().default(''), // Default: /var/lib/prilog/synapse-<slug>
    oldSigningKeyPath: zod_1.z.string().default(''), // Default: /opt/prilog/tenants/<slug>/signing.key
});
async function handleTenantBoxImport(commandId, args, send) {
    const start = Date.now();
    let parsed;
    try {
        parsed = TenantBoxImportSchema.parse(args?.config);
    }
    catch (err) {
        const msg = err?.issues
            ? err.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join(', ')
            : (err?.message ?? String(err));
        reply(send, commandId, false, { error: `Config: ${msg}` });
        return;
    }
    const slug = parsed.slug;
    const oldSynapseContainer = parsed.oldSynapseContainer || `synapse-${slug}`;
    const oldMediaPath = parsed.oldMediaPath || `/var/lib/prilog/synapse-${slug}`;
    const oldSigningKeyPath = parsed.oldSigningKeyPath || `/opt/prilog/tenants/${slug}/signing.key`;
    logger_js_1.logger.info(`[tenant-box] import ${slug} from shared layout (synapse:${parsed.synapsePort}, minio:${parsed.minioPort})`);
    const importStaging = `/tmp/import-${slug}-${Date.now()}`;
    const dir = tenantDir(slug);
    try {
        // 1. signing.key vom alten Pfad lesen — Invariante!
        const oldSigningKey = await node_fs_1.promises.readFile(oldSigningKeyPath, 'utf8').catch(() => null);
        if (!oldSigningKey) {
            throw new Error(`Alte signing.key nicht gefunden unter ${oldSigningKeyPath} — Identität wäre nicht erhaltbar!`);
        }
        const config = {
            ...parsed,
            signingKey: oldSigningKey.trim(),
        };
        // 2. Staging-Dir + Snapshot der alten Daten
        await node_fs_1.promises.mkdir(importStaging, { recursive: true });
        // 2a. pg_dump aus shared Postgres
        logger_js_1.logger.info(`[tenant-box] import: pg_dump ${parsed.oldDbName}`);
        await (0, safe_exec_js_1.safeExec)('bash', ['-c',
            `sudo -u postgres pg_dump -Fc ${parsed.oldDbName} > ${importStaging}/dump.pgcustom`,
        ]);
        // 2b. mc mirror aus shared MinIO Bucket (alias 'local' siehe agent-Setup)
        logger_js_1.logger.info(`[tenant-box] import: mc mirror ${parsed.oldBucketName}`);
        await node_fs_1.promises.mkdir(`${importStaging}/bucket`, { recursive: true });
        await (0, safe_exec_js_1.safeExec)('bash', ['-c',
            `mc mirror --quiet local/${parsed.oldBucketName}/ ${importStaging}/bucket/ 2>&1 | tail -3`,
        ]);
        // 2c. Media-Files (kopieren später nach compose up — sonst chown-Stress)
        const mediaExists = await node_fs_1.promises.stat(oldMediaPath).then(() => true).catch(() => false);
        // 2d. Pre-Flight: Sind die neuen Ports wirklich frei?
        //     Vorher (bis 2026-05-02) haben wir den alten Container gestoppt
        //     BEVOR wir den Port checkten — bei Konflikt war der Tenant dann
        //     offline während wir auf den Bug stießen. Jetzt FAIL-FAST hier.
        const portUsed = await (0, safe_exec_js_1.safeExec)('bash', ['-c',
            `ss -tlnp 2>/dev/null | grep -E ':${parsed.synapsePort}\\s' || true`,
        ], { ignoreExitCode: true });
        if (portUsed.stdout.trim() && !portUsed.stdout.includes(`synapse-${slug}`)) {
            throw new Error(`Port ${parsed.synapsePort} ist bereits belegt: ${portUsed.stdout.trim().slice(0, 200)} — Migration abgebrochen, alter Container noch online.`);
        }
        const minioPortUsed = await (0, safe_exec_js_1.safeExec)('bash', ['-c',
            `ss -tlnp 2>/dev/null | grep -E ':${parsed.minioPort}\\s' || true`,
        ], { ignoreExitCode: true });
        if (minioPortUsed.stdout.trim()) {
            throw new Error(`MinIO-Port ${parsed.minioPort} bereits belegt: ${minioPortUsed.stdout.trim().slice(0, 200)} — Migration abgebrochen, alter Container noch online.`);
        }
        // 3. Alten Synapse-Container stoppen + entfernen (nicht das Volume!)
        logger_js_1.logger.info(`[tenant-box] import: stoppe alten Container ${oldSynapseContainer}`);
        await (0, safe_exec_js_1.safeExec)('docker', ['stop', oldSynapseContainer], { ignoreExitCode: true });
        await (0, safe_exec_js_1.safeExec)('docker', ['rm', oldSynapseContainer], { ignoreExitCode: true });
        // (Downtime beginnt hier — User-Anfragen bekommen 502)
        // 4. Neue Box-Files schreiben
        await writeBoxDirectory(config);
        // 5. Nur postgres + minio starten (synapse noch NICHT — DB muss erst importiert werden)
        const composeFile = node_path_1.default.join(dir, 'docker-compose.yml');
        await (0, safe_exec_js_1.safeExec)('docker', ['compose', '-f', composeFile, 'up', '-d', 'postgres', 'minio']);
        // 5b. Auf postgres + minio healthy warten (max 60s)
        let pgReady = false, minioReady = false;
        for (let i = 0; i < 12; i++) {
            const pgState = await (0, safe_exec_js_1.safeExec)('docker', ['inspect', '--format', '{{.State.Health.Status}}', `pg-${slug}`], { ignoreExitCode: true });
            const minioState = await (0, safe_exec_js_1.safeExec)('docker', ['inspect', '--format', '{{.State.Health.Status}}', `minio-${slug}`], { ignoreExitCode: true });
            pgReady = pgState.stdout.trim() === 'healthy';
            minioReady = minioState.stdout.trim() === 'healthy';
            if (pgReady && minioReady)
                break;
            await new Promise(r => setTimeout(r, 5000));
        }
        if (!pgReady || !minioReady) {
            throw new Error(`postgres oder minio nicht healthy nach 60s (pg=${pgReady}, minio=${minioReady})`);
        }
        // 6a. PG-Restore in den NEUEN postgres-Container
        logger_js_1.logger.info(`[tenant-box] import: pg_restore in pg-${slug}`);
        await (0, safe_exec_js_1.safeExec)('bash', ['-c',
            `cat ${importStaging}/dump.pgcustom | docker exec -i pg-${slug} pg_restore -U synapse -d synapse --no-owner --no-acl`,
        ], { ignoreExitCode: true });
        // pg_restore kann harmlose Warnings ausgeben (Owner ändert sich) — ignoreExitCode
        // 6b. mc mirror in NEUE MinIO
        logger_js_1.logger.info(`[tenant-box] import: mc mirror → minio-${slug}`);
        const mcAlias = `tb-${slug}`;
        let mcReady = false;
        for (let i = 0; i < 12; i++) {
            const r = await (0, safe_exec_js_1.safeExec)('mc', [
                'alias', 'set', mcAlias,
                `http://127.0.0.1:${config.minioPort}`,
                config.minioRootUser, config.minioRootPassword,
            ], { ignoreExitCode: true });
            if (r.exitCode === 0) {
                mcReady = true;
                break;
            }
            await new Promise(r => setTimeout(r, 3000));
        }
        if (!mcReady) {
            throw new Error('mc alias konnte nicht gesetzt werden für neue MinIO');
        }
        await (0, safe_exec_js_1.safeExec)('mc', ['mb', '--ignore-existing', `${mcAlias}/${config.minioBucket}`], { ignoreExitCode: true });
        const bucketSize = await (0, safe_exec_js_1.safeExec)('bash', ['-c', `find ${importStaging}/bucket -type f | wc -l`]);
        if (parseInt(bucketSize.stdout.trim(), 10) > 0) {
            await (0, safe_exec_js_1.safeExec)('bash', ['-c',
                `mc mirror --quiet ${importStaging}/bucket/ ${mcAlias}/${config.minioBucket}/ 2>&1 | tail -3`,
            ]);
        }
        // 7. Media-Files kopieren (synapse media_store)
        if (mediaExists) {
            logger_js_1.logger.info(`[tenant-box] import: copy media`);
            const targetMedia = node_path_1.default.join(dir, 'synapse', 'media_store');
            // -a: preserve attributes, --no-target-directory: kopiere INHALT, nicht den Folder
            await (0, safe_exec_js_1.safeExec)('bash', ['-c', `cp -aT ${oldMediaPath} ${targetMedia}`], { ignoreExitCode: true });
            await (0, safe_exec_js_1.safeExec)('chown', ['-R', '991:991', targetMedia]);
        }
        // 8. Synapse jetzt starten
        logger_js_1.logger.info(`[tenant-box] import: starte synapse`);
        await (0, safe_exec_js_1.safeExec)('docker', ['compose', '-f', composeFile, 'up', '-d', 'synapse']);
        // 9. Health-Check (max 120s)
        let healthy = false;
        for (let i = 0; i < 12; i++) {
            const r = await (0, safe_exec_js_1.safeExec)('curl', [
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
                error: 'Synapse antwortet nicht nach 120s — Import angefangen aber unvollständig. Manuell prüfen.',
                result: { partial: true, importStaging },
            });
            return;
        }
        // 10. nginx-Block + reload
        await writeNginxConfig(config);
        await (0, safe_exec_js_1.safeExec)('nginx', ['-t']);
        await (0, safe_exec_js_1.safeExec)('systemctl', ['reload', 'nginx']);
        // 11. Staging-Dir aufräumen — Daten sind im neuen Stack drin
        await (0, safe_exec_js_1.safeExec)('rm', ['-rf', importStaging], { ignoreExitCode: true });
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
    }
    catch (err) {
        logger_js_1.logger.error(`[tenant-box] import failed: ${err?.message ?? err}`);
        // Staging-Dir behalten — Operator kann manuell weiter machen
        reply(send, commandId, false, { error: String(err?.message ?? err), result: { importStaging } });
    }
}
