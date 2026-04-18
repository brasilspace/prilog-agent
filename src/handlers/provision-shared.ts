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

import { z } from 'zod';
import { safeExec } from '../provision/engine/safe-exec.js';
import { logger } from '../utils/logger.js';

// ─── Config Schema ──────────────────────────────────────────────────────────

const SharedTenantConfigSchema = z.object({
  orderId:            z.string(),
  slug:               z.string().regex(/^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/),
  domain:             z.string(),       // slug.prilog.team
  displayName:        z.string(),
  dbUser:             z.string(),
  dbPassword:         z.string(),
  dbName:             z.string(),
  registrationSecret: z.string(),
  synapsePort:        z.number().int().min(8100).max(8299),
  wildcardCertPath:   z.string().default('/etc/letsencrypt/live/wildcard.prilog.team'),
  webClientRoot:      z.string().default('/var/www/prilog-web-client'),
  backendApiUrl:      z.string(),
  agentToken:         z.string().optional(),
  adminUsername:      z.string().nullish(),
  adminPassword:      z.string().nullish(),
});

type SharedTenantConfig = z.infer<typeof SharedTenantConfigSchema>;

type SendFn = (type: string, payload: unknown) => boolean;

// ─── Step Reporter ──────────────────────────────────────────────────────────

function createStepReporter(send: SendFn, orderId: string) {
  return (step: string, status: 'running' | 'success' | 'error', message?: string) => {
    send('agent.provision_step', { orderId, step, status, message });
  };
}

// ─── Handler ────────────────────────────────────────────────────────────────

export async function handleSharedTenantCreate(
  commandId: string,
  args: Record<string, unknown>,
  send: SendFn,
): Promise<void> {
  const start = Date.now();

  // ── Config validieren ─────────────────────────────────────────────
  let config: SharedTenantConfig;
  try {
    config = SharedTenantConfigSchema.parse(args?.config);
  } catch (err: any) {
    const message = err?.issues
      ? err.issues.map((i: any) => `${i.path.join('.')}: ${i.message}`).join(', ')
      : (err?.message ?? String(err));
    logger.error(`[SharedTenant] Config-Validierung fehlgeschlagen: ${message}`);
    send('agent.command_result', {
      commandId, success: false,
      output: `Config-Validierung fehlgeschlagen: ${message}`,
      duration: Date.now() - start,
    });
    return;
  }

  const report = createStepReporter(send, config.orderId);
  logger.info(`[SharedTenant] Starte Provisioning fuer ${config.slug} (Port ${config.synapsePort})`);

  try {
    // ── Step 0: PostgreSQL fuer Docker-Zugriff konfigurieren ─────
    report('configure_postgres', 'running');
    // pg_hba: Docker-Netzwerke erlauben (172.x.x.x)
    const pgHbaCheck = await safeExec('bash', ['-c',
      `PG_HBA=$(find /etc/postgresql -name pg_hba.conf | head -1) && grep -q '172.0.0.0/8' "$PG_HBA" && echo 'EXISTS' || echo 'MISSING'`
    ]);
    if (pgHbaCheck.stdout.trim() === 'MISSING') {
      await safeExec('bash', ['-c',
        `PG_HBA=$(find /etc/postgresql -name pg_hba.conf | head -1) && echo 'host all all 172.0.0.0/8 scram-sha-256' >> "$PG_HBA"`
      ]);
      // listen_addresses: Docker-Bridge hinzufuegen
      await safeExec('bash', ['-c',
        `PG_CONF=$(find /etc/postgresql -name postgresql.conf | head -1) && ` +
        `grep -q '172.17.0.1' "$PG_CONF" || ` +
        `sed -i "s/listen_addresses = '\\(.*\\)'/listen_addresses = '\\1,172.17.0.1'/" "$PG_CONF"`
      ]);
      await safeExec('systemctl', ['restart', 'postgresql']);
    }
    report('configure_postgres', 'success');

    // ── Step 1: PostgreSQL-Datenbank ──────────────────────────────
    report('create_database', 'running');
    await safeExec('sudo', [
      '-u', 'postgres', 'psql', '-c',
      `DO $$ BEGIN
        IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname='${config.dbUser}') THEN
          CREATE USER ${config.dbUser} WITH PASSWORD '${config.dbPassword}';
        END IF;
      END $$;`,
    ]);
    await safeExec('sudo', [
      '-u', 'postgres', 'psql', '-tc',
      `SELECT 1 FROM pg_database WHERE datname='${config.dbName}'`,
    ]).then(async (result) => {
      if (!result.stdout.includes('1')) {
        await safeExec('sudo', [
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
    await safeExec('mc', ['mb', `prilog-local/${bucketName}`, '--ignore-existing']);
    report('create_bucket', 'success', `Bucket: ${bucketName}`);

    // ── Step 3: Synapse-Config + Docker-Compose ──────────────────
    report('generate_synapse', 'running');
    const tenantDir = `/opt/prilog/tenants/${config.slug}`;
    await safeExec('mkdir', ['-p', tenantDir]);

    // Signing-Key generieren
    const signingKeyId = `a_${Math.random().toString(36).slice(2, 10)}`;
    const signingKeyData = Buffer.from(Array.from({ length: 32 }, () => Math.floor(Math.random() * 256))).toString('base64');
    const signingKey = `ed25519 ${signingKeyId} ${signingKeyData}`;

    await safeExec('bash', ['-c', `cat > ${tenantDir}/signing.key << 'SIGNKEY'\n${signingKey}\nSIGNKEY`]);

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

    await safeExec('bash', ['-c', `cat > ${tenantDir}/homeserver.yaml << 'HSYAML'\n${homeserverYaml}\nHSYAML`]);

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

    await safeExec('bash', ['-c', `cat > ${tenantDir}/log.config << 'LOGCFG'\n${logConfig}\nLOGCFG`]);

    // Docker-Compose
    const composeYaml = `
services:
  synapse:
    image: matrixdotorg/synapse:latest
    container_name: synapse-${config.slug}
    restart: unless-stopped
    ports:
      - "127.0.0.1:${config.synapsePort}:8008"
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

    await safeExec('bash', ['-c', `cat > ${tenantDir}/docker-compose.yml << 'COMPOSE'\n${composeYaml}\nCOMPOSE`]);
    report('generate_synapse', 'success');

    // ── Step 4: Synapse starten ──────────────────────────────────
    report('start_containers', 'running');
    await safeExec('docker', ['compose', '-f', `${tenantDir}/docker-compose.yml`, 'up', '-d']);

    // Warten auf Health-Check (max 60s)
    let healthy = false;
    for (let i = 0; i < 30; i++) {
      try {
        const res = await safeExec('curl', ['-sf', `http://127.0.0.1:${config.synapsePort}/_matrix/client/versions`]);
        if (res.stdout.includes('versions')) { healthy = true; break; }
      } catch { /* retry */ }
      await new Promise(r => setTimeout(r, 2000));
    }
    if (!healthy) throw new Error(`Synapse antwortet nicht auf Port ${config.synapsePort}`);
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

    location / {
        root ${config.webClientRoot};
        try_files $uri $uri/ /index.html;
    }
}

server {
    listen 80;
    server_name ${config.domain};
    return 301 https://$host$request_uri;
}
`.trim();

    await safeExec('bash', ['-c', `cat > /etc/nginx/prilog-tenants/${config.slug}.conf << 'NGINX'\n${nginxConf}\nNGINX`]);
    await safeExec('nginx', ['-t']);
    await safeExec('systemctl', ['reload', 'nginx']);
    report('configure_nginx', 'success');

    // ── Step 6: Port-Registry aktualisieren ──────────────────────
    report('update_registry', 'running');
    const registryPath = '/etc/prilog/port-registry.json';
    try {
      const regResult = await safeExec('cat', [registryPath]);
      const registry = JSON.parse(regResult.stdout);
      registry.tenants[config.slug] = config.synapsePort;
      if (config.synapsePort >= registry.next_port) {
        registry.next_port = config.synapsePort + 1;
      }
      await safeExec('bash', ['-c', `echo '${JSON.stringify(registry)}' > ${registryPath}`]);
    } catch {
      // Registry existiert nicht — neu anlegen
      const newRegistry = { next_port: config.synapsePort + 1, tenants: { [config.slug]: config.synapsePort } };
      await safeExec('bash', ['-c', `echo '${JSON.stringify(newRegistry)}' > ${registryPath}`]);
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
    await safeExec('bash', ['-c', `cat > ${tenantDir}/credentials.env << 'CREDS'\n${credContent}\nCREDS`]);
    await safeExec('chmod', ['600', `${tenantDir}/credentials.env`]);
    report('save_credentials', 'success');

    // ── Step 8: Admin-User erstellen ───────────────────────────
    if (config.adminUsername && config.adminPassword) {
      report('create_admin_user', 'running');
      try {
        // Nonce holen
        const nonceResult = await safeExec('curl', ['-sf', `http://127.0.0.1:${config.synapsePort}/_synapse/admin/v1/register`]);
        const nonce = JSON.parse(nonceResult.stdout).nonce;

        // HMAC berechnen: nonce\0username\0password\0admin
        const hmacInput = `${nonce}\0${config.adminUsername}\0${config.adminPassword}\0admin`;
        const hmacResult = await safeExec('bash', ['-c',
          `printf '%s' '${hmacInput}' | openssl dgst -sha1 -hmac '${config.registrationSecret}' | awk '{print $2}'`
        ]);
        const mac = hmacResult.stdout.trim();

        // User registrieren
        const regBody = JSON.stringify({
          nonce,
          username: config.adminUsername,
          password: config.adminPassword,
          admin: true,
          mac,
        });
        await safeExec('curl', [
          '-sf', '-X', 'POST',
          `http://127.0.0.1:${config.synapsePort}/_synapse/admin/v1/register`,
          '-H', 'Content-Type: application/json',
          '-d', regBody,
        ]);
        report('create_admin_user', 'success', `Admin: @${config.adminUsername}:${config.domain}`);
      } catch (err: any) {
        // Nicht fatal — User kann auch manuell erstellt werden
        report('create_admin_user', 'error', `Admin-User Fehler: ${err.message}`);
        logger.warn(`[SharedTenant] Admin-User Erstellung fehlgeschlagen: ${err.message}`);
      }
    }

    // ── Fertig ───────────────────────────────────────────────────
    logger.info(`[SharedTenant] ${config.slug} erfolgreich provisioniert`);
    send('agent.command_result', {
      commandId,
      success: true,
      output: `Shared-Tenant ${config.slug} provisioniert (Port ${config.synapsePort})`,
      duration: Date.now() - start,
    });

  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    logger.error(`[SharedTenant] Fehler: ${message}`);
    send('agent.command_result', {
      commandId,
      success: false,
      output: `Shared-Tenant Provisioning fehlgeschlagen: ${message}`,
      duration: Date.now() - start,
    });
  }
}
