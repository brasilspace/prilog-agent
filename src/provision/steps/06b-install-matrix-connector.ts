/**
 * provision/steps/06b-install-matrix-connector.ts
 *
 * Installiert und konfiguriert den Prilog Matrix Connector idempotent.
 *
 * Ablauf:
 *  1. Repo clone/pull
 *  2. homeserver.yaml um Modulblock erweitern
 *  3. Spaeterer Compose-Step mountet den Connector in den Synapse-Container
 */

import { ProvisionConfig } from '../types.js';
import { ensureMatrixConnectorInstalled, verifyMatrixConnectorInstalled } from '../connector.js';
import { logger } from '../../utils/logger.js';

export async function stepInstallMatrixConnector(cfg: ProvisionConfig): Promise<void> {
  const result = await ensureMatrixConnectorInstalled(cfg);
  logger.info(`[Step connector] ${result.message}`);
}

export async function verifyInstallMatrixConnector(cfg: ProvisionConfig): Promise<void> {
  verifyMatrixConnectorInstalled(cfg);
}
