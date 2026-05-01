/**
 * handlers/migration.ts
 *
 * Tenant-Migration zwischen Shared-Hosts. Quelle bzw. Ziel — derselbe
 * Agent kann beide Rollen einnehmen (auf source.snapshot/transfer/cutover_stop,
 * auf target.restore/verify/cleanup).
 *
 * Erwartete Layout-Annahmen:
 *  - PostgreSQL laeuft lokal (psql via lokalem Socket) — kein Container,
 *    Cluster ist auf jedem Shared-Host gleich aufgesetzt.
 *  - MinIO laeuft lokal als Container, ALIAS 'local' via mc konfiguriert.
 *  - Synapse-Daten unter /var/lib/prilog/synapse-${slug}/.
 *  - docker-compose pro Tenant unter /opt/prilog/tenants/${slug}/docker-compose.yml.
 *
 * Diese Annahmen entsprechen dem Shared-Provision-Pattern (siehe
 * provision-shared.ts). Wenn die Pfade abweichen, muessen sie hier
 * angepasst werden.
 */

import { promises as fs } from 'node:fs';
import { safeExec } from '../provision/engine/safe-exec.js';
import { logger } from '../utils/logger.js';

/** Shell-Wrapper fuer Pipes/Redirects via bash -c. safeExec ist no-shell. */
async function sh(script: string, opts?: { allowFail?: boolean }): Promise<{ stdout: string; stderr: string }> {
  try {
    const r = await safeExec('bash', ['-c', script], { timeout: 30 * 60_000 });
    return { stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
  } catch (err) {
    if (opts?.allowFail) return { stdout: '', stderr: String(err) };
    throw err;
  }
}

type SendFn = (type: string, payload: unknown) => boolean;

const INCOMING_DIR = '/var/lib/prilog/incoming';
const SNAPSHOT_DIR = '/var/lib/prilog/snapshots';

function workDir(migrationId: string): string {
  return `${SNAPSHOT_DIR}/${migrationId}`;
}

function reply(send: SendFn, commandId: string, success: boolean, payload: Record<string, unknown> = {}) {
  send('agent.command_result', { commandId, success, ...payload });
}

// ─── Source: Snapshot ──────────────────────────────────────────────────────
// args: { migrationId, slug, dbName, dbUser, bucketName }
// returns: { bundlePath, bundleSize }
export async function handleSnapshot(commandId: string, args: Record<string, unknown>, send: SendFn): Promise<void> {
  const migrationId = String(args.migrationId);
  const slug = String(args.slug);
  const dbName = String(args.dbName);
  const bucketName = String(args.bucketName);

  const dir = workDir(migrationId);
  const bundlePath = `${dir}/migration-${migrationId}.tar.gz`;

  try {
    await sh(`mkdir -p ${dir}`);

    // 1. pg_dump (custom format fuer schnelles restore)
    // Output via stdout-Pipe: sudo-User postgres erzeugt den Dump, root
    // schreibt die Datei. Sonst: Permission denied (postgres hat keinen
    // Schreibzugriff auf agent-erstelltes Verzeichnis).
    logger.info(`[migration] pg_dump ${dbName} → ${dir}/db.dump`);
    await sh(`sudo -u postgres pg_dump -Fc ${dbName} > ${dir}/db.dump`);

    // 2. MinIO bucket -> tar (mc mirror local/${bucket} → /tmp + tar)
    logger.info(`[migration] mc mirror ${bucketName} → ${dir}/bucket/`);
    await sh(`mkdir -p ${dir}/bucket && mc mirror --quiet local/${bucketName} ${dir}/bucket/ 2>&1 | tail -5`);

    // 3. Synapse-Daten (media + state)
    const synapseDataDir = `/var/lib/prilog/synapse-${slug}`;
    const exists = await fs.stat(synapseDataDir).then(() => true).catch(() => false);
    if (exists) {
      logger.info(`[migration] synapse-data ${synapseDataDir} → ${dir}/synapse.tar.gz`);
      await sh(`tar -czf ${dir}/synapse.tar.gz -C ${synapseDataDir} .`);
    } else {
      logger.warn(`[migration] synapse-data nicht gefunden: ${synapseDataDir} — wird uebersprungen`);
    }

    // 4. Compose-Config + homeserver.yaml + signing.key (alles aus /opt/prilog/tenants/<slug>)
    // Ohne das wuerde Restore zwar Daten haben, aber kein Synapse starten koennen.
    const composeDir = `/opt/prilog/tenants/${slug}`;
    const composeExists = await fs.stat(composeDir).then(() => true).catch(() => false);
    if (composeExists) {
      logger.info(`[migration] compose-dir ${composeDir} → ${dir}/compose.tar.gz`);
      await sh(`tar -czf ${dir}/compose.tar.gz -C ${composeDir} .`);
    } else {
      logger.warn(`[migration] compose-dir nicht gefunden: ${composeDir} — Synapse muss auf Target neu konfiguriert werden`);
    }

    // 5. Alles in ein Bundle
    const bundleParts = ['db.dump', 'bucket'];
    if (exists) bundleParts.push('synapse.tar.gz');
    if (composeExists) bundleParts.push('compose.tar.gz');
    await sh(`tar -czf ${bundlePath} -C ${dir} ${bundleParts.join(' ')}`);

    const stat = await fs.stat(bundlePath);
    reply(send, commandId, true, { result: { bundlePath, bundleSize: stat.size } });
  } catch (err: any) {
    logger.error(`[migration] snapshot failed: ${err?.message ?? err}`);
    reply(send, commandId, false, { error: String(err?.message ?? err) });
  }
}

// ─── Source: Transfer ──────────────────────────────────────────────────────
// args: { migrationId, bundlePath, targetHost, targetPath }
// returns: { transferred: number }
export async function handleTransfer(commandId: string, args: Record<string, unknown>, send: SendFn): Promise<void> {
  const bundlePath = String(args.bundlePath);
  const targetHost = String(args.targetHost);
  const targetPath = String(args.targetPath);

  try {
    // SSH key zwischen Shared-Hosts ist bereits eingerichtet (Tailscale-only).
    // rsync fail-soft, fortgesetzt im Fehlerfall via partial flag.
    await sh(`ssh -o StrictHostKeyChecking=accept-new ${targetHost} "mkdir -p ${INCOMING_DIR}"`);
    await sh(`rsync -a --partial --info=progress2 ${bundlePath} ${targetHost}:${targetPath}`);

    const stat = await fs.stat(bundlePath);
    reply(send, commandId, true, { result: { transferred: stat.size } });
  } catch (err: any) {
    logger.error(`[migration] transfer failed: ${err?.message ?? err}`);
    reply(send, commandId, false, { error: String(err?.message ?? err) });
  }
}

// ─── Target: Restore ───────────────────────────────────────────────────────
// args: { migrationId, bundlePath, slug, domain, displayName, dbName, dbUser,
//         dbPassword, synapsePort, bucketName, registrationSecret }
export async function handleRestore(commandId: string, args: Record<string, unknown>, send: SendFn): Promise<void> {
  const migrationId = String(args.migrationId);
  const bundlePath = String(args.bundlePath);
  const slug = String(args.slug);
  const domain = String(args.domain ?? `${slug}.prilog.team`);
  const dbName = String(args.dbName);
  const dbUser = String(args.dbUser);
  const dbPassword = String(args.dbPassword);
  const synapsePort = Number(args.synapsePort);
  const bucketName = String(args.bucketName);

  const dir = `${INCOMING_DIR}/restore-${migrationId}`;

  try {
    await sh(`mkdir -p ${dir} && tar -xzf ${bundlePath} -C ${dir}`);

    // 1. DB-User + DB anlegen
    // WICHTIG: Synapse verlangt Collation 'C' (sonst 'IncorrectDatabaseSetup'-Crash).
    // Wenn DB schon existiert (z.B. aus vorherigem Restore-Versuch), pruefen wir
    // die Collation und erstellen sie ggf. neu — sonst schlaegt Synapse-Start fehl.
    await sh(`sudo -u postgres psql -tAc "SELECT 1 FROM pg_user WHERE usename = '${dbUser}'" | grep -q 1 || sudo -u postgres psql -c "CREATE USER ${dbUser} WITH PASSWORD '${dbPassword}'"`);
    const dbCheck = await sh(`sudo -u postgres psql -tAc "SELECT datcollate FROM pg_database WHERE datname = '${dbName}'"`, { allowFail: true });
    const currentCollate = dbCheck.stdout.trim();
    if (currentCollate && currentCollate !== 'C') {
      logger.info(`[migration] DB ${dbName} hat falsche Collation (${currentCollate}) — neu erstellen mit C`);
      await sh(`sudo -u postgres dropdb --if-exists ${dbName}`);
    }
    if (!currentCollate || currentCollate !== 'C') {
      await sh(`sudo -u postgres createdb -O ${dbUser} -E UTF8 --lc-collate=C --lc-ctype=C -T template0 ${dbName}`);
    }

    // 2. pg_restore
    await sh(`sudo -u postgres pg_restore --clean --if-exists --no-owner --role=${dbUser} -d ${dbName} ${dir}/db.dump`);

    // 3. MinIO bucket
    await sh(`mc mb --ignore-existing local/${bucketName}`);
    await sh(`mc mirror --quiet ${dir}/bucket/ local/${bucketName} 2>&1 | tail -3`);

    // 4. Synapse-Daten unter /var/lib/prilog/synapse-${slug}/ einspielen
    const synapseTar = `${dir}/synapse.tar.gz`;
    if (await fs.stat(synapseTar).then(() => true).catch(() => false)) {
      const synapseDataDir = `/var/lib/prilog/synapse-${slug}`;
      await sh(`mkdir -p ${synapseDataDir}`);
      await sh(`tar -xzf ${synapseTar} -C ${synapseDataDir}`);
    }

    // 5. Compose-Dir wiederherstellen (homeserver.yaml + docker-compose.yml + signing.key)
    const composeDir = `/opt/prilog/tenants/${slug}`;
    const composeTar = `${dir}/compose.tar.gz`;
    if (await fs.stat(composeTar).then(() => true).catch(() => false)) {
      await sh(`mkdir -p ${composeDir} && tar -xzf ${composeTar} -C ${composeDir}`);
      // WICHTIG: Port-Mapping in docker-compose.yml umschreiben — Source-Host
      // hatte einen anderen Port (z.B. 8102), Target weist evtl. anderen zu
      // (z.B. 8101). Sonst startet Container auf altem Port, nginx-conf zeigt
      // auf neuen → Tenant unerreichbar.
      await sh(`sed -i -E 's|(0\\.0\\.0\\.0:)[0-9]+(:8008)|\\1${synapsePort}\\2|' ${composeDir}/docker-compose.yml`);
    }

    // 6. docker-compose stack starten
    const composeFile = `${composeDir}/docker-compose.yml`;
    if (await fs.stat(composeFile).then(() => true).catch(() => false)) {
      await sh(`cd ${composeDir} && docker compose up -d`);
      // chown media_store auf Synapse-User (UID 991) — sonst Media-Upload-Errors
      await sh(`docker exec --user root synapse-${slug} chown -R 991:991 /data/media_store 2>&1 || true`);
    } else {
      throw new Error(`docker-compose.yml fehlt unter ${composeFile} — Synapse kann nicht gestartet werden`);
    }

    // 7. Nginx-Server-Block fuer den Tenant — sonst ist der Tenant ueber
    //    seine prilog.team-URL nicht erreichbar (kein 443-server_name match).
    //    Format identisch zu provision-shared.ts handleSharedTenantCreate.
    await writeTenantNginxConfig(slug, domain, synapsePort);
    await sh(`nginx -t`);
    await sh(`systemctl reload nginx`);

    reply(send, commandId, true, { result: { restored: true, synapsePort } });
  } catch (err: any) {
    logger.error(`[migration] restore failed: ${err?.message ?? err}`);
    reply(send, commandId, false, { error: String(err?.message ?? err) });
  }
}

// ─── Source: Cutover-Stop ──────────────────────────────────────────────────
// args: { slug, synapsePort }
export async function handleCutoverStop(commandId: string, args: Record<string, unknown>, send: SendFn): Promise<void> {
  const slug = String(args.slug);
  const composeDir = `/opt/prilog/tenants/${slug}`;
  try {
    if (await fs.stat(`${composeDir}/docker-compose.yml`).then(() => true).catch(() => false)) {
      await sh(`cd ${composeDir} && docker compose down`);
    }
    reply(send, commandId, true, { result: { stopped: true } });
  } catch (err: any) {
    reply(send, commandId, false, { error: String(err?.message ?? err) });
  }
}

// ─── Target: Verify ────────────────────────────────────────────────────────
// args: { slug, synapsePort }
// Synapse kann nach docker compose up -d zwischen 30 und 90 Sekunden brauchen
// bis es responsive ist (DB-Migrations beim ersten Start, etc.). Wir versuchen
// mit Backoff bis zu 12 × 10 Sekunden = 2 Min total.
export async function handleVerify(commandId: string, args: Record<string, unknown>, send: SendFn): Promise<void> {
  const synapsePort = Number(args.synapsePort);
  const maxAttempts = 12;
  let lastErr: string | null = null;
  for (let i = 1; i <= maxAttempts; i++) {
    try {
      const r = await sh(`curl -fsS --max-time 8 http://127.0.0.1:${synapsePort}/_matrix/client/versions || echo FAIL`);
      const healthy = r.stdout.includes('versions') || r.stdout.includes('m.client');
      if (healthy) {
        reply(send, commandId, true, { result: { healthy: true, message: `Synapse antwortet (Versuch ${i}/${maxAttempts})` } });
        return;
      }
      lastErr = `kein versions-Header (Versuch ${i}/${maxAttempts})`;
    } catch (err: any) {
      lastErr = String(err?.message ?? err);
    }
    if (i < maxAttempts) await new Promise((r) => setTimeout(r, 10_000));
  }
  try {
    reply(send, commandId, true, { result: { healthy: false, message: `Synapse antwortet nicht nach ${maxAttempts} Versuchen: ${lastErr}` } });
  } catch (err: any) {
    reply(send, commandId, true, { result: { healthy: false, message: String(err?.message ?? err) } });
  }
}

// ─── Target: Cleanup ───────────────────────────────────────────────────────
// args: { migrationId, bundlePath }
export async function handleCleanup(commandId: string, args: Record<string, unknown>, send: SendFn): Promise<void> {
  const bundlePath = String(args.bundlePath);
  const migrationId = String(args.migrationId);
  try {
    await sh(`rm -f ${bundlePath} && rm -rf ${INCOMING_DIR}/restore-${migrationId}`, { allowFail: true });
    reply(send, commandId, true, { result: { cleaned: true } });
  } catch {
    reply(send, commandId, true, { result: { cleaned: false } });
  }
}

// ─── Nginx-Server-Block fuer Tenant ─────────────────────────────────────────
// Wird beim Restore-Step geschrieben — analog zu provision-shared.ts.
// Wildcard-Cert wird vorausgesetzt unter /etc/letsencrypt/live/wildcard.prilog.team.
async function writeTenantNginxConfig(slug: string, domain: string, synapsePort: number): Promise<void> {
  const conf = `server {
    listen 443 ssl http2;
    server_name ${domain};

    ssl_certificate     /etc/letsencrypt/live/wildcard.prilog.team/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/wildcard.prilog.team/privkey.pem;

    location /_matrix {
        proxy_pass http://127.0.0.1:${synapsePort};
        proxy_set_header X-Forwarded-For $remote_addr;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_set_header Host $host;
        client_max_body_size 50M;
    }

    location /_synapse/client {
        proxy_pass http://127.0.0.1:${synapsePort};
        proxy_set_header Host $host;
    }

    location /.well-known/matrix/server {
        default_type application/json;
        return 200 '{"m.server": "${domain}:443"}';
    }

    location /.well-known/matrix/client {
        default_type application/json;
        add_header Access-Control-Allow-Origin *;
        return 200 '{"m.homeserver": {"base_url": "https://${domain}"}}';
    }

    location /api/ {
        proxy_pass https://api.prilog.chat/api/;
        proxy_set_header Host api.prilog.chat;
        proxy_set_header X-Forwarded-For $remote_addr;
        proxy_set_header X-Real-Tenant ${domain};
        proxy_ssl_server_name on;
    }

    location ~ ^/tenant- {
        proxy_pass http://127.0.0.1:9000;
        proxy_set_header Host ${domain};
        proxy_request_buffering off;
        client_max_body_size 200m;
    }

    location /api/platform/v1/workflow/events/stream {
        proxy_pass https://api.prilog.chat/api/platform/v1/workflow/events/stream;
        proxy_set_header Host api.prilog.chat;
        proxy_set_header X-Real-Tenant ${domain};
        proxy_ssl_server_name on;
        proxy_buffering off;
        proxy_cache off;
        proxy_read_timeout 86400s;
    }

    location / {
        root /var/www/prilog-web-client;
        try_files $uri $uri/ /index.html;
    }
}

server {
    listen 80;
    server_name ${domain};
    return 301 https://$host$request_uri;
}
`;
  const path = `/etc/nginx/prilog-tenants/${slug}.conf`;
  await fs.writeFile(path, conf);
}
