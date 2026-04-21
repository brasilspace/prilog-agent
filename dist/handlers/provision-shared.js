"use strict";
/**
 * handlers/provision-shared.ts
 *
 * Provisioning eines Shared-Tenants auf einem bestehenden Shared Host.
 * Im Gegensatz zum Dedicated-Provisioning wird hier KEIN Server erstellt,
 * sondern nur: PostgreSQL-DB, MinIO-Bucket, Synapse-Container, Nginx-Config.
 *
 * Wird von agent.ts aufgerufen wenn:
 *   msg.type === 'server.command' && cmd.command === 'shared_tenant.create'
 *
 * Das Backend sendet:
 *   { command: "shared_tenant.create", args: { config: SharedTenantConfig } }
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
exports.handleSharedTenantCreate = handleSharedTenantCreate;
const zod_1 = require("zod");
const safe_exec_js_1 = require("../provision/engine/safe-exec.js");
const logger_js_1 = require("../utils/logger.js");
// ─── Config Schema ──────────────────────────────────────────────────────────
const SharedTenantConfigSchema = zod_1.z.object({
    orderId: zod_1.z.string(),
    slug: zod_1.z.string().regex(/^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/),
    domain: zod_1.z.string(), // slug.prilog.team
    displayName: zod_1.z.string(),
    dbUser: zod_1.z.string(),
    dbPassword: zod_1.z.string(),
    dbName: zod_1.z.string(),
    registrationSecret: zod_1.z.string(),
    synapsePort: zod_1.z.number().int().min(8100).max(8299),
    wildcardCertPath: zod_1.z.string().default('/etc/letsencrypt/live/wildcard.prilog.team'),
    webClientRoot: zod_1.z.string().default('/var/www/prilog-web-client'),
    backendApiUrl: zod_1.z.string(),
    agentToken: zod_1.z.string().nullish(),
    adminUsername: zod_1.z.string().nullish(),
    adminPassword: zod_1.z.string().nullish(),
});
// ─── Step Reporter ──────────────────────────────────────────────────────────
function createStepReporter(send, orderId) {
    return (step, status, message) => {
        send('agent.provision_step', { orderId, step, status, message });
    };
}
// ─── Handler ────────────────────────────────────────────────────────────────
async function handleSharedTenantCreate(commandId, args, send) {
    const start = Date.now();
    // ── Config validieren ─────────────────────────────────────────────
    let config;
    try {
        config = SharedTenantConfigSchema.parse(args?.config);
    }
    catch (err) {
        const message = err?.issues
            ? err.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join(', ')
            : (err?.message ?? String(err));
        logger_js_1.logger.error(`[SharedTenant] Config-Validierung fehlgeschlagen: ${message}`);
        send('agent.command_result', {
            commandId, success: false,
            output: `Config-Validierung fehlgeschlagen: ${message}`,
            duration: Date.now() - start,
        });
        return;
    }
    const report = createStepReporter(send, config.orderId);
    logger_js_1.logger.info(`[SharedTenant] Starte Provisioning fuer ${config.slug} (Port ${config.synapsePort})`);
    try {
        // ── Step 0: PostgreSQL fuer Docker-Zugriff konfigurieren ─────
        report('configure_postgres', 'running');
        // pg_hba: Docker-Netzwerke erlauben (172.x.x.x)
        const pgHbaCheck = await (0, safe_exec_js_1.safeExec)('bash', ['-c',
            `PG_HBA=$(find /etc/postgresql -name pg_hba.conf | head -1) && grep -q '172.0.0.0/8' "$PG_HBA" && echo 'EXISTS' || echo 'MISSING'`
        ]);
        if (pgHbaCheck.stdout.trim() === 'MISSING') {
            await (0, safe_exec_js_1.safeExec)('bash', ['-c',
                `PG_HBA=$(find /etc/postgresql -name pg_hba.conf | head -1) && echo 'host all all 172.0.0.0/8 scram-sha-256' >> "$PG_HBA"`
            ]);
            // listen_addresses: Docker-Bridge hinzufuegen
            await (0, safe_exec_js_1.safeExec)('bash', ['-c',
                `PG_CONF=$(find /etc/postgresql -name postgresql.conf | head -1) && ` +
                    `grep -q '172.17.0.1' "$PG_CONF" || ` +
                    `sed -i "s/listen_addresses = '\\(.*\\)'/listen_addresses = '\\1,172.17.0.1'/" "$PG_CONF"`
            ]);
            await (0, safe_exec_js_1.safeExec)('systemctl', ['restart', 'postgresql']);
        }
        report('configure_postgres', 'success');
        // ── Step 1: PostgreSQL-Datenbank ──────────────────────────────
        report('create_database', 'running');
        await (0, safe_exec_js_1.safeExec)('sudo', [
            '-u', 'postgres', 'psql', '-c',
            `DO $$ BEGIN
        IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname='${config.dbUser}') THEN
          CREATE USER ${config.dbUser} WITH PASSWORD '${config.dbPassword}';
        END IF;
      END $$;`,
        ]);
        await (0, safe_exec_js_1.safeExec)('sudo', [
            '-u', 'postgres', 'psql', '-tc',
            `SELECT 1 FROM pg_database WHERE datname='${config.dbName}'`,
        ]).then(async (result) => {
            if (!result.stdout.includes('1')) {
                await (0, safe_exec_js_1.safeExec)('sudo', [
                    '-u', 'postgres', 'createdb',
                    '-O', config.dbUser, '-E', 'UTF8',
                    '--locale=C', '--template=template0', config.dbName,
                ]);
            }
        });
        report('create_database', 'success', `DB: ${config.dbName}`);
        // ── Step 2: MinIO-Bucket ─────────────────────────────────────
        report('create_bucket', 'running');
        const bucketName = `tenant-${config.slug}`;
        await (0, safe_exec_js_1.safeExec)('mc', ['mb', `prilog-local/${bucketName}`, '--ignore-existing']);
        report('create_bucket', 'success', `Bucket: ${bucketName}`);
        // ── Step 3: Synapse-Config + Docker-Compose ──────────────────
        report('generate_synapse', 'running');
        const tenantDir = `/opt/prilog/tenants/${config.slug}`;
        await (0, safe_exec_js_1.safeExec)('mkdir', ['-p', tenantDir]);
        // Signing-Key generieren
        const signingKeyId = `a_${Math.random().toString(36).slice(2, 10)}`;
        const signingKeyData = Buffer.from(Array.from({ length: 32 }, () => Math.floor(Math.random() * 256))).toString('base64');
        const signingKey = `ed25519 ${signingKeyId} ${signingKeyData}`;
        await (0, safe_exec_js_1.safeExec)('bash', ['-c', `cat > ${tenantDir}/signing.key << 'SIGNKEY'\n${signingKey}\nSIGNKEY`]);
        // homeserver.yaml
        const homeserverYaml = `
server_name: "${config.domain}"
pid_file: /data/homeserver.pid
public_baseurl: "https://${config.domain}/"

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
    user: ${config.dbUser}
    password: "${config.dbPassword}"
    database: ${config.dbName}
    host: host.docker.internal
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
`.trim();
        await (0, safe_exec_js_1.safeExec)('bash', ['-c', `cat > ${tenantDir}/homeserver.yaml << 'HSYAML'\n${homeserverYaml}\nHSYAML`]);
        // Log-Config
        const logConfig = `
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
`.trim();
        await (0, safe_exec_js_1.safeExec)('bash', ['-c', `cat > ${tenantDir}/log.config << 'LOGCFG'\n${logConfig}\nLOGCFG`]);
        // Docker-Compose
        const composeYaml = `
services:
  synapse:
    image: matrixdotorg/synapse:latest
    container_name: synapse-${config.slug}
    restart: unless-stopped
    ports:
      - "0.0.0.0:${config.synapsePort}:8008"
    volumes:
      - ./homeserver.yaml:/data/homeserver.yaml:ro
      - ./signing.key:/data/signing.key:ro
      - ./log.config:/data/log.config:ro
      - synapse-data-${config.slug}:/data/media_store
    extra_hosts:
      - "host.docker.internal:host-gateway"
    environment:
      - SYNAPSE_CONFIG_PATH=/data/homeserver.yaml
    mem_limit: 512m
    cpus: 0.5

volumes:
  synapse-data-${config.slug}:
`.trim();
        await (0, safe_exec_js_1.safeExec)('bash', ['-c', `cat > ${tenantDir}/docker-compose.yml << 'COMPOSE'\n${composeYaml}\nCOMPOSE`]);
        report('generate_synapse', 'success');
        // ── Step 4: Synapse starten ──────────────────────────────────
        report('start_containers', 'running');
        await (0, safe_exec_js_1.safeExec)('docker', ['compose', '-f', `${tenantDir}/docker-compose.yml`, 'up', '-d']);
        // Warten auf Health-Check (max 60s)
        let healthy = false;
        for (let i = 0; i < 30; i++) {
            try {
                const res = await (0, safe_exec_js_1.safeExec)('curl', ['-sf', `http://127.0.0.1:${config.synapsePort}/_matrix/client/versions`]);
                if (res.stdout.includes('versions')) {
                    healthy = true;
                    break;
                }
            }
            catch { /* retry */ }
            await new Promise(r => setTimeout(r, 2000));
        }
        if (!healthy)
            throw new Error(`Synapse antwortet nicht auf Port ${config.synapsePort}`);
        report('start_containers', 'success', `Synapse laeuft auf Port ${config.synapsePort}`);
        // ── Step 5: Nginx-Config ─────────────────────────────────────
        report('configure_nginx', 'running');
        const nginxConf = `
# Tenant: ${config.slug} (${config.displayName})
# Erstellt: ${new Date().toISOString()}
server {
    listen 443 ssl http2;
    server_name ${config.domain};

    ssl_certificate     ${config.wildcardCertPath}/fullchain.pem;
    ssl_certificate_key ${config.wildcardCertPath}/privkey.pem;

    location /_matrix {
        proxy_pass http://127.0.0.1:${config.synapsePort};
        proxy_set_header X-Forwarded-For $remote_addr;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_set_header Host $host;
        client_max_body_size 50M;
    }

    location /_synapse/client {
        proxy_pass http://127.0.0.1:${config.synapsePort};
        proxy_set_header X-Forwarded-For $remote_addr;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_set_header Host $host;
    }

    location /.well-known/matrix/server {
        default_type application/json;
        return 200 '{"m.server": "${config.domain}:443"}';
    }

    location /.well-known/matrix/client {
        default_type application/json;
        add_header Access-Control-Allow-Origin *;
        return 200 '{"m.homeserver": {"base_url": "https://${config.domain}"}}';
    }

    # Platform API → zentrales Backend
    location /api/ {
        proxy_pass https://api.prilog.chat/api/;
        proxy_set_header Host api.prilog.chat;
        proxy_set_header X-Forwarded-For $remote_addr;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_set_header X-Real-Tenant ${config.domain};
        proxy_ssl_server_name on;
    }

    # SSE Stream — kein Buffering
    location /api/platform/v1/workflow/events/stream {
        proxy_pass https://api.prilog.chat/api/platform/v1/workflow/events/stream;
        proxy_set_header Host api.prilog.chat;
        proxy_set_header X-Forwarded-For $remote_addr;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_set_header X-Real-Tenant ${config.domain};
        proxy_ssl_server_name on;
        proxy_buffering off;
        proxy_cache off;
        proxy_read_timeout 86400s;
        proxy_send_timeout 86400s;
    }

    location / {
        root ${config.webClientRoot};
        try_files $uri $uri/ /index.html;

        # index.html nie cachen (Service Worker + neue Deploys)
        location = /index.html {
            add_header Cache-Control "no-cache, no-store, must-revalidate";
        }
    }
}

server {
    listen 80;
    server_name ${config.domain};
    return 301 https://$host$request_uri;
}
`.trim();
        await (0, safe_exec_js_1.safeExec)('bash', ['-c', `cat > /etc/nginx/prilog-tenants/${config.slug}.conf << 'NGINX'\n${nginxConf}\nNGINX`]);
        await (0, safe_exec_js_1.safeExec)('nginx', ['-t']);
        await (0, safe_exec_js_1.safeExec)('systemctl', ['reload', 'nginx']);
        report('configure_nginx', 'success');
        // ── Step 6: Port-Registry aktualisieren ──────────────────────
        report('update_registry', 'running');
        const registryPath = '/etc/prilog/port-registry.json';
        try {
            const regResult = await (0, safe_exec_js_1.safeExec)('cat', [registryPath]);
            const registry = JSON.parse(regResult.stdout);
            registry.tenants[config.slug] = config.synapsePort;
            if (config.synapsePort >= registry.next_port) {
                registry.next_port = config.synapsePort + 1;
            }
            await (0, safe_exec_js_1.safeExec)('bash', ['-c', `echo '${JSON.stringify(registry)}' > ${registryPath}`]);
        }
        catch {
            // Registry existiert nicht — neu anlegen
            const newRegistry = { next_port: config.synapsePort + 1, tenants: { [config.slug]: config.synapsePort } };
            await (0, safe_exec_js_1.safeExec)('bash', ['-c', `echo '${JSON.stringify(newRegistry)}' > ${registryPath}`]);
        }
        report('update_registry', 'success');
        // ── Step 7: Credentials speichern ────────────────────────────
        report('save_credentials', 'running');
        const credContent = [
            `SLUG=${config.slug}`,
            `DOMAIN=${config.domain}`,
            `DISPLAY_NAME=${config.displayName}`,
            `SYNAPSE_PORT=${config.synapsePort}`,
            `DB_NAME=${config.dbName}`,
            `DB_USER=${config.dbUser}`,
            `REGISTRATION_SECRET=${config.registrationSecret}`,
        ].join('\n');
        await (0, safe_exec_js_1.safeExec)('bash', ['-c', `cat > ${tenantDir}/credentials.env << 'CREDS'\n${credContent}\nCREDS`]);
        await (0, safe_exec_js_1.safeExec)('chmod', ['600', `${tenantDir}/credentials.env`]);
        report('save_credentials', 'success');
        // ── Step 8: Admin-User erstellen ───────────────────────────
        if (config.adminUsername && config.adminPassword) {
            report('create_admin_user', 'running');
            try {
                // Nonce holen
                const nonceResult = await (0, safe_exec_js_1.safeExec)('curl', ['-sf', `http://127.0.0.1:${config.synapsePort}/_synapse/admin/v1/register`]);
                const nonce = JSON.parse(nonceResult.stdout).nonce;
                // HMAC in Node.js berechnen (Null-Bytes funktionieren nicht in Shell-Args)
                const crypto = await Promise.resolve().then(() => __importStar(require('crypto')));
                const hmac = crypto.createHmac('sha1', config.registrationSecret);
                hmac.update(nonce);
                hmac.update('\0');
                hmac.update(config.adminUsername);
                hmac.update('\0');
                hmac.update(config.adminPassword);
                hmac.update('\0');
                hmac.update('admin');
                const mac = hmac.digest('hex');
                // User registrieren
                const regBody = JSON.stringify({
                    nonce,
                    username: config.adminUsername,
                    password: config.adminPassword,
                    admin: true,
                    mac,
                });
                await (0, safe_exec_js_1.safeExec)('curl', [
                    '-sf', '-X', 'POST',
                    `http://127.0.0.1:${config.synapsePort}/_synapse/admin/v1/register`,
                    '-H', 'Content-Type: application/json',
                    '-d', regBody,
                ]);
                report('create_admin_user', 'success', `Admin: @${config.adminUsername}:${config.domain}`);
            }
            catch (err) {
                // Nicht fatal — User kann auch manuell erstellt werden
                report('create_admin_user', 'error', `Admin-User Fehler: ${err.message}`);
                logger_js_1.logger.warn(`[SharedTenant] Admin-User Erstellung fehlgeschlagen: ${err.message}`);
            }
        }
        // ── Fertig ───────────────────────────────────────────────────
        logger_js_1.logger.info(`[SharedTenant] ${config.slug} erfolgreich provisioniert`);
        send('agent.command_result', {
            commandId,
            success: true,
            output: `Shared-Tenant ${config.slug} provisioniert (Port ${config.synapsePort})`,
            duration: Date.now() - start,
            sharedTenantOrderId: config.orderId,
        });
    }
    catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        logger_js_1.logger.error(`[SharedTenant] Fehler: ${message}`);
        send('agent.command_result', {
            commandId,
            success: false,
            output: `Shared-Tenant Provisioning fehlgeschlagen: ${message}`,
            duration: Date.now() - start,
        });
    }
}
