/**
 * provision/steps/04-start-containers.ts
 *
 * Step 4: Docker Compose starten und auf Health warten.
 *
 * Ablauf:
 *  1. docker compose pull (neuestes Image)
 *  2. docker compose up -d
 *  3. Polling bis Synapse-Container "healthy" → max 5 Minuten
 *
 * Idempotenz: docker compose up -d ist idempotent.
 *             Bereits laufende Container werden nicht neu erstellt.
 */

import { exec }      from 'child_process';
import { execSync }  from 'child_process';
import { promisify } from 'util';
import { ProvisionConfig } from '../types.js';
import { logger }          from '../../utils/logger.js';

const execAsync = promisify(exec);

const COMPOSE_PATH   = '/opt/prilog/docker-compose.yml';
const MAX_WAIT_MS    = 5 * 60 * 1000;   // 5 Minuten
const POLL_INTERVAL  = 10_000;           // 10 Sekunden

// ─── Container Health Check ───────────────────────────────────────────────────

function getContainerHealth(containerName: string): string {
  try {
    const out = execSync(
      `docker inspect --format='{{.State.Health.Status}}' ${containerName} 2>/dev/null`,
      { timeout: 5_000 }
    ).toString().trim().replace(/'/g, '');
    return out || 'unknown';
  } catch {
    return 'not_found';
  }
}

function isContainerRunning(containerName: string): boolean {
  try {
    const out = execSync(
      `docker inspect --format='{{.State.Running}}' ${containerName} 2>/dev/null`,
      { timeout: 5_000 }
    ).toString().trim().replace(/'/g, '');
    return out === 'true';
  } catch {
    return false;
  }
}

// ─── Wait for Synapse ─────────────────────────────────────────────────────────

async function waitForSynapse(): Promise<void> {
  const start = Date.now();

  // Mögliche Container-Namen (docker compose generiert automatisch)
  const candidateNames = ['prilog-synapse-1', 'synapse'];

  logger.info('[Step 4] Warte auf Synapse (max 5 Min)...');

  while (Date.now() - start < MAX_WAIT_MS) {
    for (const name of candidateNames) {
      const health = getContainerHealth(name);

      if (health === 'healthy') {
        const elapsed = Math.round((Date.now() - start) / 1000);
        logger.info(`[Step 4] ✅ Synapse healthy (${name}, nach ${elapsed}s)`);
        return;
      }

      if (health === 'not_found') continue;

      // running aber noch nicht healthy — warten
      logger.info(`[Step 4] Synapse: ${name} → ${health} — warte...`);
    }

    await new Promise(resolve => setTimeout(resolve, POLL_INTERVAL));
  }

  // Timeout — Fehler mit Debug-Infos
  let debugInfo = '';
  try {
    const { stdout } = await execAsync('docker ps --format "table {{.Names}}\\t{{.Status}}"', { timeout: 10_000 });
    debugInfo = stdout;
  } catch {}

  throw new Error(
    `Synapse wurde nicht healthy nach ${MAX_WAIT_MS / 60000} Minuten.\n` +
    `Docker Status:\n${debugInfo}`
  );
}

// ─── Step ─────────────────────────────────────────────────────────────────────

export async function stepStartContainers(_cfg: ProvisionConfig): Promise<void> {
  // ── Idempotenz: bereits laufend? ──────────────────────────────────
  const alreadyRunning =
    isContainerRunning('prilog-synapse-1') ||
    isContainerRunning('synapse');

  if (alreadyRunning) {
    const health = getContainerHealth('prilog-synapse-1') ||
                   getContainerHealth('synapse');

    if (health === 'healthy') {
      logger.info('[Step 4] Container bereits laufend und healthy — überspringe');
      return;
    }
  }

  // ── Images pullen ─────────────────────────────────────────────────
  logger.info('[Step 4] Pulle Docker Images...');
  await execAsync(`docker compose -f ${COMPOSE_PATH} pull`, { timeout: 180_000 });
  logger.info('[Step 4] Images gepullt');

  // ── Container starten ────────────────────────────────────────────
  logger.info('[Step 4] Starte Container...');
  await execAsync(`docker compose -f ${COMPOSE_PATH} up -d`, { timeout: 60_000 });
  logger.info('[Step 4] Container gestartet');

  // ── Auf Synapse-Health warten ────────────────────────────────────
  await waitForSynapse();
}

export async function verifyStartContainers(_cfg: ProvisionConfig): Promise<void> {
  const candidates = ['prilog-synapse-1', 'synapse'];
  let healthy = false;
  for (const name of candidates) {
    if (getContainerHealth(name) === 'healthy') { healthy = true; break; }
  }
  if (!healthy) {
    let debug = '';
    try { debug = execSync('docker ps --format "{{.Names}}: {{.Status}}"', { timeout: 5_000 }).toString(); } catch {}
    throw new Error(`Synapse nicht healthy nach Container-Start.\n${debug}`);
  }
}
