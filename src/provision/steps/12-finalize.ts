/**
 * provision/steps/08-finalize.ts
 *
 * Step 8: Finalisierung — Backend über abgeschlossenes Provisioning informieren.
 *
 * Sendet POST /api/agent/ready → Backend setzt installationStatus = 'complete',
 * speichert den synapseAdminToken und verschickt die "Server bereit" E-Mail.
 */

import { ProvisionConfig } from '../types.js';
import { logger }          from '../../utils/logger.js';
import { safeExec }        from '../engine/safe-exec.js';

export async function stepFinalize(cfg: ProvisionConfig): Promise<void> {
  logger.info('[Step 8] Sende Ready-Callback ans Backend...');

  const url  = `${cfg.backendApiUrl}/api/agent/ready`;
  const body = JSON.stringify({
    status: 'ready',
    orderId: cfg.orderId,
    synapseAdminToken: (cfg as any).synapseAdminToken ?? null,
  });

  try {
    const result = await safeExec('curl', [
      '-sf', '-X', 'POST',
      url,
      '-H', `Authorization: Bearer ${cfg.agentToken}`,
      '-H', 'Content-Type: application/json',
      '-d', body,
      '--max-time', '30',
      '--retry', '3',
      '--retry-delay', '5',
    ], { timeout: 60_000 });
    logger.info(`[Step 8] Backend Antwort: ${result.stdout.trim()}`);
    logger.info('[Step 8] Provisioning abgeschlossen — Server ist bereit!');
  } catch (err: any) {
    const msg = err?.message || String(err);
    logger.warn(`[Step 8] Ready-Callback fehlgeschlagen (nicht fatal): ${msg}`);
    throw new Error(`Ready-Callback fehlgeschlagen: ${msg}`);
  }
}

export async function verifyFinalize(_cfg: ProvisionConfig): Promise<void> {
  // Kein weiterer Check nötig
}
