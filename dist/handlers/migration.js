"use strict";
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
Object.defineProperty(exports, "__esModule", { value: true });
exports.handleSnapshot = handleSnapshot;
exports.handleTransfer = handleTransfer;
exports.handleRestore = handleRestore;
exports.handleCutoverStop = handleCutoverStop;
exports.handleVerify = handleVerify;
exports.handleCleanup = handleCleanup;
const node_fs_1 = require("node:fs");
const safe_exec_js_1 = require("../provision/engine/safe-exec.js");
const logger_js_1 = require("../utils/logger.js");
/** Shell-Wrapper fuer Pipes/Redirects via bash -c. safeExec ist no-shell. */
async function sh(script, opts) {
    try {
        const r = await (0, safe_exec_js_1.safeExec)('bash', ['-c', script], { timeout: 30 * 60_000 });
        return { stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
    }
    catch (err) {
        if (opts?.allowFail)
            return { stdout: '', stderr: String(err) };
        throw err;
    }
}
const INCOMING_DIR = '/var/lib/prilog/incoming';
const SNAPSHOT_DIR = '/var/lib/prilog/snapshots';
function workDir(migrationId) {
    return `${SNAPSHOT_DIR}/${migrationId}`;
}
function reply(send, commandId, success, payload = {}) {
    send('agent.command_result', { commandId, success, ...payload });
}
// ─── Source: Snapshot ──────────────────────────────────────────────────────
// args: { migrationId, slug, dbName, dbUser, bucketName }
// returns: { bundlePath, bundleSize }
async function handleSnapshot(commandId, args, send) {
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
        logger_js_1.logger.info(`[migration] pg_dump ${dbName} → ${dir}/db.dump`);
        await sh(`sudo -u postgres pg_dump -Fc ${dbName} > ${dir}/db.dump`);
        // 2. MinIO bucket -> tar (mc mirror local/${bucket} → /tmp + tar)
        logger_js_1.logger.info(`[migration] mc mirror ${bucketName} → ${dir}/bucket/`);
        await sh(`mkdir -p ${dir}/bucket && mc mirror --quiet local/${bucketName} ${dir}/bucket/ 2>&1 | tail -5`);
        // 3. Synapse-Daten (media + state)
        const synapseDataDir = `/var/lib/prilog/synapse-${slug}`;
        const exists = await node_fs_1.promises.stat(synapseDataDir).then(() => true).catch(() => false);
        if (exists) {
            logger_js_1.logger.info(`[migration] synapse-data ${synapseDataDir} → ${dir}/synapse.tar.gz`);
            await sh(`tar -czf ${dir}/synapse.tar.gz -C ${synapseDataDir} .`);
        }
        else {
            logger_js_1.logger.warn(`[migration] synapse-data nicht gefunden: ${synapseDataDir} — wird uebersprungen`);
        }
        // 4. Compose-Config + homeserver.yaml + signing.key (alles aus /opt/prilog/tenants/<slug>)
        // Ohne das wuerde Restore zwar Daten haben, aber kein Synapse starten koennen.
        const composeDir = `/opt/prilog/tenants/${slug}`;
        const composeExists = await node_fs_1.promises.stat(composeDir).then(() => true).catch(() => false);
        if (composeExists) {
            logger_js_1.logger.info(`[migration] compose-dir ${composeDir} → ${dir}/compose.tar.gz`);
            await sh(`tar -czf ${dir}/compose.tar.gz -C ${composeDir} .`);
        }
        else {
            logger_js_1.logger.warn(`[migration] compose-dir nicht gefunden: ${composeDir} — Synapse muss auf Target neu konfiguriert werden`);
        }
        // 5. Alles in ein Bundle
        const bundleParts = ['db.dump', 'bucket'];
        if (exists)
            bundleParts.push('synapse.tar.gz');
        if (composeExists)
            bundleParts.push('compose.tar.gz');
        await sh(`tar -czf ${bundlePath} -C ${dir} ${bundleParts.join(' ')}`);
        const stat = await node_fs_1.promises.stat(bundlePath);
        reply(send, commandId, true, { result: { bundlePath, bundleSize: stat.size } });
    }
    catch (err) {
        logger_js_1.logger.error(`[migration] snapshot failed: ${err?.message ?? err}`);
        reply(send, commandId, false, { error: String(err?.message ?? err) });
    }
}
// ─── Source: Transfer ──────────────────────────────────────────────────────
// args: { migrationId, bundlePath, targetHost, targetPath }
// returns: { transferred: number }
async function handleTransfer(commandId, args, send) {
    const bundlePath = String(args.bundlePath);
    const targetHost = String(args.targetHost);
    const targetPath = String(args.targetPath);
    try {
        // SSH key zwischen Shared-Hosts ist bereits eingerichtet (Tailscale-only).
        // rsync fail-soft, fortgesetzt im Fehlerfall via partial flag.
        await sh(`ssh -o StrictHostKeyChecking=accept-new ${targetHost} "mkdir -p ${INCOMING_DIR}"`);
        await sh(`rsync -a --partial --info=progress2 ${bundlePath} ${targetHost}:${targetPath}`);
        const stat = await node_fs_1.promises.stat(bundlePath);
        reply(send, commandId, true, { result: { transferred: stat.size } });
    }
    catch (err) {
        logger_js_1.logger.error(`[migration] transfer failed: ${err?.message ?? err}`);
        reply(send, commandId, false, { error: String(err?.message ?? err) });
    }
}
// ─── Target: Restore ───────────────────────────────────────────────────────
// args: { migrationId, bundlePath, slug, domain, displayName, dbName, dbUser,
//         dbPassword, synapsePort, bucketName, registrationSecret }
async function handleRestore(commandId, args, send) {
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
            logger_js_1.logger.info(`[migration] DB ${dbName} hat falsche Collation (${currentCollate}) — neu erstellen mit C`);
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
        if (await node_fs_1.promises.stat(synapseTar).then(() => true).catch(() => false)) {
            const synapseDataDir = `/var/lib/prilog/synapse-${slug}`;
            await sh(`mkdir -p ${synapseDataDir}`);
            await sh(`tar -xzf ${synapseTar} -C ${synapseDataDir}`);
        }
        // 5. Compose-Dir wiederherstellen (homeserver.yaml + docker-compose.yml + signing.key)
        const composeDir = `/opt/prilog/tenants/${slug}`;
        const composeTar = `${dir}/compose.tar.gz`;
        if (await node_fs_1.promises.stat(composeTar).then(() => true).catch(() => false)) {
            await sh(`mkdir -p ${composeDir} && tar -xzf ${composeTar} -C ${composeDir}`);
            // WICHTIG: Port-Mapping in docker-compose.yml umschreiben — Source-Host
            // hatte einen anderen Port (z.B. 8102) und evtl. ein anderes Bind-IP
            // (z.B. 127.0.0.1 fuer localhost-only). Wir vereinheitlichen IMMER auf
            // 0.0.0.0:${synapsePort}:8008 — nginx proxied von aussen, daher muss
            // der Container auf allen Interfaces lauschen.
            // Pattern matched jedes "<beliebige-IP>:<Port>:8008", damit auch alte
            // 127.0.0.1-Bindings (siehe demo-Tenant) korrekt umgeschrieben werden.
            await sh(`sed -i -E 's|"[^"]*:[0-9]+:8008"|"0.0.0.0:${synapsePort}:8008"|' ${composeDir}/docker-compose.yml`);
            // Assert: Port wurde tatsaechlich gesetzt — sonst hat das compose-Format
            // sich geaendert und unser sed griff nicht (silent fail = unerreichbarer Tenant)
            const portCheck = await sh(`grep -E '"0\\.0\\.0\\.0:${synapsePort}:8008"' ${composeDir}/docker-compose.yml`, { allowFail: true });
            if (!portCheck.stdout.includes(`0.0.0.0:${synapsePort}:8008`)) {
                throw new Error(`Port-Rewrite in docker-compose.yml fehlgeschlagen — erwartet '"0.0.0.0:${synapsePort}:8008"'. Compose-Format hat sich evtl. geaendert.`);
            }
        }
        // 6. docker-compose stack starten
        const composeFile = `${composeDir}/docker-compose.yml`;
        if (await node_fs_1.promises.stat(composeFile).then(() => true).catch(() => false)) {
            // Pre-Flight: ist der Port schon belegt? Sonst kommt von docker
            // ein kryptisches "Bind for 0.0.0.0:XXXX failed: port is already
            // allocated" (siehe demo-Migration 2026-05-01). Wir wollen frueh
            // mit klarer Meldung scheitern, BEVOR docker compose half-up state
            // hinterlaesst.
            const portBound = await sh(`ss -tlnp 2>/dev/null | grep -E ':${synapsePort}\\s' || true`, { allowFail: true });
            if (portBound.stdout.trim()) {
                // Wenn der Port schon vom EIGENEN Container belegt ist (z.B. retry
                // einer Migration), ist das kein Konflikt — compose up handhabt das.
                const ownContainer = await sh(`docker ps --filter "name=synapse-${slug}" --filter "publish=${synapsePort}" --format '{{.Names}}'`, { allowFail: true });
                if (!ownContainer.stdout.includes(`synapse-${slug}`)) {
                    throw new Error(`Port ${synapsePort} ist bereits belegt von einem anderen Prozess: ${portBound.stdout.trim().slice(0, 200)}. Migration abgebrochen, bevor docker compose half-up Zustand erzeugt.`);
                }
            }
            await sh(`cd ${composeDir} && docker compose up -d`);
            // chown media_store auf Synapse-User (UID 991) — sonst Media-Upload-Errors
            await sh(`docker exec --user root synapse-${slug} chown -R 991:991 /data/media_store 2>&1 || true`);
        }
        else {
            throw new Error(`docker-compose.yml fehlt unter ${composeFile} — Synapse kann nicht gestartet werden`);
        }
        // 7. Nginx-Server-Block fuer den Tenant — sonst ist der Tenant ueber
        //    seine prilog.team-URL nicht erreichbar (kein 443-server_name match).
        //    Format identisch zu provision-shared.ts handleSharedTenantCreate.
        await writeTenantNginxConfig(slug, domain, synapsePort);
        await sh(`nginx -t`);
        await sh(`systemctl reload nginx`);
        reply(send, commandId, true, { result: { restored: true, synapsePort } });
    }
    catch (err) {
        logger_js_1.logger.error(`[migration] restore failed: ${err?.message ?? err}`);
        reply(send, commandId, false, { error: String(err?.message ?? err) });
    }
}
// ─── Source: Cutover-Stop ──────────────────────────────────────────────────
// args: { slug, synapsePort }
async function handleCutoverStop(commandId, args, send) {
    const slug = String(args.slug);
    const composeDir = `/opt/prilog/tenants/${slug}`;
    try {
        if (await node_fs_1.promises.stat(`${composeDir}/docker-compose.yml`).then(() => true).catch(() => false)) {
            await sh(`cd ${composeDir} && docker compose down`);
        }
        reply(send, commandId, true, { result: { stopped: true } });
    }
    catch (err) {
        reply(send, commandId, false, { error: String(err?.message ?? err) });
    }
}
// ─── Target: Verify ────────────────────────────────────────────────────────
// args: { slug, synapsePort }
// Synapse kann nach docker compose up -d zwischen 30 und 90 Sekunden brauchen
// bis es responsive ist (DB-Migrations beim ersten Start, etc.). Wir versuchen
// mit Backoff bis zu 12 × 10 Sekunden = 2 Min total.
async function handleVerify(commandId, args, send) {
    const synapsePort = Number(args.synapsePort);
    const maxAttempts = 12;
    let lastErr = null;
    for (let i = 1; i <= maxAttempts; i++) {
        try {
            const r = await sh(`curl -fsS --max-time 8 http://127.0.0.1:${synapsePort}/_matrix/client/versions || echo FAIL`);
            const healthy = r.stdout.includes('versions') || r.stdout.includes('m.client');
            if (healthy) {
                reply(send, commandId, true, { result: { healthy: true, message: `Synapse antwortet (Versuch ${i}/${maxAttempts})` } });
                return;
            }
            lastErr = `kein versions-Header (Versuch ${i}/${maxAttempts})`;
        }
        catch (err) {
            lastErr = String(err?.message ?? err);
        }
        if (i < maxAttempts)
            await new Promise((r) => setTimeout(r, 10_000));
    }
    // Unhealthy → success:false damit Backend's sendAgentCommand sauber
    // rejected. Vorher (success:true + healthy:false) hat funktioniert weil
    // der Caller `result.healthy` selbst pruefte, war aber brittle: jeder
    // neue Caller der vergisst zu pruefen wuerde silent-pass sehen.
    reply(send, commandId, false, { error: `Synapse antwortet nicht nach ${maxAttempts} Versuchen: ${lastErr}`, result: { healthy: false, message: `Synapse antwortet nicht nach ${maxAttempts} Versuchen: ${lastErr}` } });
}
// ─── Target: Cleanup ───────────────────────────────────────────────────────
// args: { migrationId, bundlePath }
async function handleCleanup(commandId, args, send) {
    const bundlePath = String(args.bundlePath);
    const migrationId = String(args.migrationId);
    try {
        await sh(`rm -f ${bundlePath} && rm -rf ${INCOMING_DIR}/restore-${migrationId}`, { allowFail: true });
        reply(send, commandId, true, { result: { cleaned: true } });
    }
    catch {
        reply(send, commandId, true, { result: { cleaned: false } });
    }
}
// ─── Nginx-Server-Block fuer Tenant ─────────────────────────────────────────
// Wird beim Restore-Step geschrieben — analog zu provision-shared.ts.
// Wildcard-Cert wird vorausgesetzt unter /etc/letsencrypt/live/wildcard.prilog.team.
async function writeTenantNginxConfig(slug, domain, synapsePort) {
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
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection 'upgrade';
    }

    # MinIO S3 proxy: per-Tenant prefix-Block (location /tenant-${slug}/)
    # wird durch tenant-box.ts erzeugt. KEIN globaler Regex-Block — er haette
    # Vorrang vor prefix-Match und wuerde zu Port 9000 routen, der seit der
    # per-Tenant-MinIO-Architektur nicht mehr existiert.

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
    await node_fs_1.promises.writeFile(path, conf);
}
