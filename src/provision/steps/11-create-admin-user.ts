/**
 * provision/steps/07-create-admin-user.ts
 *
 * Step 7: Matrix Admin-User über die Synapse Shared Secret API anlegen.
 *
 * Synapse bietet zwei Wege:
 *  a) register_new_matrix_user CLI (im Container)
 *  b) Shared Secret API mit HMAC-SHA1 Signatur
 *
 * Wir nutzen Option (a) — sicherer, kein externer HTTP-Aufruf nötig,
 * und funktioniert auch wenn Port 8008 noch nicht von außen erreichbar ist.
 *
 * Idempotenz: Prüft ob Admin-User bereits existiert via Synapse Admin API.
 *             docker exec register_new_matrix_user gibt Fehler wenn User existiert,
 *             wir fangen das ab.
 */

import { exec }      from 'child_process';
import { execSync }  from 'child_process';
import { promisify } from 'util';
import { ProvisionConfig } from '../types.js';
import { logger }          from '../../utils/logger.js';

const execAsync = promisify(exec);

// ─── Container Name ermitteln ─────────────────────────────────────────────────

function getSynapseContainerName(): string {
  const candidates = ['prilog-synapse-1', 'synapse'];
  for (const name of candidates) {
    try {
      const out = execSync(
        `docker inspect --format='{{.State.Running}}' ${name} 2>/dev/null`,
        { timeout: 5_000 }
      ).toString().trim().replace(/'/g, '');
      if (out === 'true') return name;
    } catch {}
  }
  throw new Error('Synapse Container nicht gefunden');
}

// ─── Admin-User existiert bereits? ───────────────────────────────────────────

async function adminUserExists(cfg: ProvisionConfig): Promise<boolean> {
  try {
    // Direkt im lokalen Postgres-Container prüfen
    const { stdout } = await execAsync(
      `docker exec prilog-postgres-1 psql -U synapse -d synapse -tAc "SELECT COUNT(*) FROM users WHERE name = '@${cfg.adminUsername}:${cfg.matrixDomain}'"`,
      { timeout: 10_000 }
    );
    return parseInt(stdout.trim(), 10) > 0;
  } catch {
    return false;
  }
}

// ─── Step ─────────────────────────────────────────────────────────────────────

export async function stepCreateAdminUser(cfg: ProvisionConfig): Promise<void> {
  // ── Idempotenz: User bereits vorhanden? ──────────────────────────
  const exists = await adminUserExists(cfg);
  if (exists) {
    logger.info(`[Step 7] Admin-User @${cfg.adminUsername} bereits vorhanden — überspringe`);
    return;
  }

  const containerName = getSynapseContainerName();
  logger.info(`[Step 7] Erstelle Admin-User @${cfg.adminUsername} via ${containerName}...`);

  // ── register_new_matrix_user ausführen ────────────────────────────
  // Flags: -u Username, -p Passwort, -a Admin, -c homeserver.yaml
  const cmd = [
    `docker exec ${containerName}`,
    'register_new_matrix_user',
    `-u ${cfg.adminUsername}`,
    `-p ${cfg.adminPassword}`,
    '-a',
    '-c /data/homeserver.yaml',
    'http://localhost:8008',
  ].join(' ');

  try {
    const { stdout, stderr } = await execAsync(cmd, { timeout: 30_000 });
    const output = (stdout + stderr).trim();

    // Erfolgsmeldung enthält "Success!"
    if (output.includes('Success') || output.includes('success')) {
      logger.info(`[Step 7] Admin-User @${cfg.adminUsername} erstellt ✅`);
    } else if (output.includes('already exists') || output.includes('already in use')) {
      // User existiert bereits — kein Fehler
      logger.info(`[Step 7] Admin-User @${cfg.adminUsername} existiert bereits (OK)`);
    } else {
      logger.info(`[Step 7] register_new_matrix_user Output: ${output}`);
    }
  } catch (err: any) {
    const msg = (err?.stdout || '') + (err?.stderr || '') + (err?.message || '') || String(err);

    // "already in use" ist kein echter Fehler
    if (msg.includes('already in use') || msg.includes('already exists') || msg.includes('already taken')) {
      logger.info(`[Step 7] Admin-User @${cfg.adminUsername} existiert bereits (OK)`);
      return;
    }

    throw new Error(`Admin-User anlegen fehlgeschlagen: ${msg}`);
  }
}

export async function verifyCreateAdminUser(cfg: ProvisionConfig): Promise<void> {
  const exists = await adminUserExists(cfg);
  if (!exists) {
    throw new Error(`Admin-User "${cfg.adminUsername}" nicht in Synapse-DB vorhanden nach Erstellung`);
  }
}
