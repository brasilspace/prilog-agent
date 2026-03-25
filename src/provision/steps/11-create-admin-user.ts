/**
 * provision/steps/07-create-admin-user.ts
 *
 * Step 7: Matrix Admin-User über die Synapse Shared Secret API anlegen.
 * Nach dem Anlegen wird ein Synapse access_token via Login geholt
 * und in cfg.synapseAdminToken gespeichert — der finalize-Step
 * sendet ihn ans Backend zur Speicherung in der DB.
 */

import { ProvisionConfig } from '../types.js';
import { logger }          from '../../utils/logger.js';
import { safeExec, dockerExec } from '../engine/safe-exec.js';

// ─── Container Name ermitteln ─────────────────────────────────────────────────

async function getSynapseContainerName(): Promise<string> {
  const candidates = ['prilog-synapse-1', 'synapse'];
  for (const name of candidates) {
    const result = await safeExec(
      'docker', ['inspect', '--format={{.State.Running}}', name],
      { ignoreExitCode: true, timeout: 5_000 },
    );
    if (result.exitCode === 0 && result.stdout.trim().replace(/'/g, '') === 'true') return name;
  }
  throw new Error('Synapse Container nicht gefunden');
}

// ─── Admin-User existiert bereits? ───────────────────────────────────────────

async function adminUserExists(cfg: ProvisionConfig): Promise<boolean> {
  try {
    const result = await dockerExec('prilog-postgres-1', [
      'psql', '-U', 'synapse', '-d', 'synapse', '-tAc',
      `SELECT COUNT(*) FROM users WHERE name = '@${cfg.adminUsername}:${cfg.matrixDomain}'`,
    ], { timeout: 10_000 });
    return parseInt(result.stdout.trim(), 10) > 0;
  } catch {
    return false;
  }
}

// ─── Synapse Admin-Token via Matrix Login holen ───────────────────────────────

export async function getSynapseAdminToken(cfg: ProvisionConfig): Promise<string> {
  const adminPasswordDecoded = Buffer.from(cfg.adminPasswordB64, 'base64').toString('utf8');

  const loginPayload = JSON.stringify({
    type: 'm.login.password',
    identifier: { type: 'm.id.user', user: cfg.adminUsername },
    password: adminPasswordDecoded,
  });

  const result = await safeExec(
    'curl', ['-sf', '-X', 'POST', 'http://localhost:8008/_matrix/client/v3/login',
             '-H', 'Content-Type: application/json',
             '-d', loginPayload,
             '--max-time', '15'],
    { timeout: 20_000 },
  );

  const response = JSON.parse(result.stdout.trim());
  if (!response.access_token) {
    throw new Error(`Synapse Login fehlgeschlagen: ${JSON.stringify(response)}`);
  }
  return response.access_token;
}

// ─── Step ─────────────────────────────────────────────────────────────────────

export async function stepCreateAdminUser(cfg: ProvisionConfig): Promise<void> {
  // ── Idempotenz: User bereits vorhanden? ──────────────────────────
  const exists = await adminUserExists(cfg);
  if (exists) {
    logger.info(`[Step 7] Admin-User @${cfg.adminUsername} bereits vorhanden — überspringe`);
    return;
  }

  const containerName = await getSynapseContainerName();
  logger.info(`[Step 7] Erstelle Admin-User @${cfg.adminUsername} via ${containerName}...`);

  // ── register_new_matrix_user ausführen ────────────────────────────
  // Passwort aus Base64 dekodieren
  const adminPasswordDecoded = Buffer.from(cfg.adminPasswordB64, 'base64').toString('utf8');

  try {
    const result = await dockerExec(containerName, [
      'register_new_matrix_user',
      '-u', cfg.adminUsername,
      '-p', adminPasswordDecoded,
      '-a',
      '-c', '/data/homeserver.yaml',
      'http://localhost:8008',
    ], { timeout: 30_000 });
    const output = (result.stdout + result.stderr).trim();

    if (output.includes('Success') || output.includes('success')) {
      logger.info(`[Step 7] Admin-User @${cfg.adminUsername} erstellt`);
    } else if (output.includes('already exists') || output.includes('already in use')) {
      logger.info(`[Step 7] Admin-User @${cfg.adminUsername} existiert bereits (OK)`);
    } else {
      logger.info(`[Step 7] register_new_matrix_user Output: ${output}`);
    }
  } catch (err: any) {
    const msg = err?.message || String(err);

    if (msg.includes('already in use') || msg.includes('already exists') || msg.includes('already taken')) {
      logger.info(`[Step 7] Admin-User @${cfg.adminUsername} existiert bereits (OK)`);
      return;
    }

    throw new Error(`Admin-User anlegen fehlgeschlagen: ${msg}`);
  }

  // ── Admin-Token holen und in cfg speichern ────────────────────────
  logger.info('[Step 7] Hole Synapse Admin-Token...');
  try {
    const token = await getSynapseAdminToken(cfg);
    (cfg as any).synapseAdminToken = token;
    logger.info('[Step 7] Synapse Admin-Token erhalten');
  } catch (err: any) {
    // Nicht fatal — finalize-Step sendet was vorhanden ist
    logger.warn(`[Step 7] Synapse Admin-Token konnte nicht geholt werden: ${err.message}`);
  }
}

export async function verifyCreateAdminUser(cfg: ProvisionConfig): Promise<void> {
  const exists = await adminUserExists(cfg);
  if (!exists) {
    throw new Error(`Admin-User "${cfg.adminUsername}" nicht in Synapse-DB vorhanden nach Erstellung`);
  }
}
