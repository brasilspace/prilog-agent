/**
 * provision/steps/03-write-compose.ts
 *
 * Step 3: docker-compose.yml für Synapse + PostgreSQL schreiben.
 *
 * Idempotenz: Immer überschreiben — gleiche Config ergibt gleiche Datei.
 *             docker compose up -d ist ebenfalls idempotent.
 */

import { ProvisionConfig } from '../types.js';
import { logger }          from '../../utils/logger.js';
import { COMPOSE_DIR, COMPOSE_PATH, writeComposeFile } from '../compose.js';
import { execSync } from 'child_process';

// ─── Step ─────────────────────────────────────────────────────────────────────

export async function stepWriteCompose(cfg: ProvisionConfig): Promise<void> {
  writeComposeFile(cfg);

  logger.info(`[Step 3] docker-compose.yml geschrieben: ${COMPOSE_PATH}`);
}

export async function verifyWriteCompose(_cfg: ProvisionConfig): Promise<void> {
  try {
    execSync(`test -f ${COMPOSE_DIR}/docker-compose.yml`, { stdio: 'ignore' });
  } catch {
    throw new Error('docker-compose.yml fehlt nach Write-Compose');
  }
  // YAML-Syntax prüfen
  try {
    execSync(`docker compose -f ${COMPOSE_DIR}/docker-compose.yml config --quiet`, {
      stdio: 'ignore', timeout: 10_000,
    });
  } catch {
    throw new Error('docker-compose.yml ist ungültig (docker compose config fehlgeschlagen)');
  }
}
