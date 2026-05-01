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

    // 4. Alles in ein Bundle
    await sh(`tar -czf ${bundlePath} -C ${dir} db.dump bucket synapse.tar.gz 2>/dev/null || tar -czf ${bundlePath} -C ${dir} db.dump bucket`);

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
  const dbName = String(args.dbName);
  const dbUser = String(args.dbUser);
  const dbPassword = String(args.dbPassword);
  const synapsePort = Number(args.synapsePort);
  const bucketName = String(args.bucketName);

  const dir = `${INCOMING_DIR}/restore-${migrationId}`;

  try {
    await sh(`mkdir -p ${dir} && tar -xzf ${bundlePath} -C ${dir}`);

    // 1. DB-User + DB anlegen
    await sh(`sudo -u postgres psql -tAc "SELECT 1 FROM pg_user WHERE usename = '${dbUser}'" | grep -q 1 || sudo -u postgres psql -c "CREATE USER ${dbUser} WITH PASSWORD '${dbPassword}'"`);
    await sh(`sudo -u postgres psql -tAc "SELECT 1 FROM pg_database WHERE datname = '${dbName}'" | grep -q 1 || sudo -u postgres createdb -O ${dbUser} ${dbName}`);

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

    // 5. docker-compose stack starten — nutzt das vorhandene shared-tenant-Layout
    const composeDir = `/opt/prilog/tenants/${slug}`;
    const composeFile = `${composeDir}/docker-compose.yml`;
    if (await fs.stat(composeFile).then(() => true).catch(() => false)) {
      await sh(`cd ${composeDir} && docker compose up -d`);
    } else {
      logger.warn(`[migration] kein docker-compose unter ${composeFile} — Synapse bitte manuell starten`);
    }

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
export async function handleVerify(commandId: string, args: Record<string, unknown>, send: SendFn): Promise<void> {
  const synapsePort = Number(args.synapsePort);
  try {
    const r = await sh(`curl -fsS --max-time 10 http://127.0.0.1:${synapsePort}/_matrix/client/versions || echo FAIL`);
    const healthy = r.stdout.includes('versions') || r.stdout.includes('m.client');
    reply(send, commandId, true, { result: { healthy, message: healthy ? 'Synapse antwortet' : 'Synapse-Endpoint reagiert nicht' } });
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
