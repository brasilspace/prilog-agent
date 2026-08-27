/**
 * provision/steps/06d-install-managed-rooms.ts
 *
 * Installiert `synapse-managed-rooms` idempotent.
 *
 * Ablauf:
 *  1. Artefakt laden und entpacken
 *  2. homeserver.yaml um den Modulblock erweitern
 *  3. Spaeterer Compose-Step mountet das Modul in den Synapse-Container
 */

import { ProvisionConfig } from '../types.js';
import { ensureManagedRoomsInstalled, verifyManagedRoomsInstalled } from '../managed-rooms.js';
import { logger } from '../../utils/logger.js';

export async function stepInstallManagedRooms(cfg: ProvisionConfig): Promise<void> {
  const result = await ensureManagedRoomsInstalled(cfg);
  logger.info(`[Step managed-rooms] ${result.message}`);
}

export async function verifyInstallManagedRooms(cfg: ProvisionConfig): Promise<void> {
  verifyManagedRoomsInstalled(cfg);
}
