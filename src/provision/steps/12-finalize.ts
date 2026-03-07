/**
 * provision/steps/08-finalize.ts
 *
 * Step 8: Finalisierung — Backend über abgeschlossenes Provisioning informieren.
 *
 * Ruft POST /api/agent/ready auf → Backend setzt installationStatus = 'complete'
 * und verschickt die "Server bereit" E-Mail an den Kunden.
 *
 * Idempotenz: Mehrfaches Aufrufen ist sicher — Backend-Endpoint ist idempotent.
 */

import { exec, execSync } from 'child_process';
import { promisify } from 'util';
import { ProvisionConfig } from '../types.js';
import { logger }          from '../../utils/logger.js';

const execAsync = promisify(exec);

export async function stepFinalize(cfg: ProvisionConfig): Promise<void> {
  logger.info('[Step 8] Sende Ready-Callback ans Backend...');

  const url  = `${cfg.backendApiUrl}/api/agent/ready`;
  const body = JSON.stringify({ status: 'ready', orderId: cfg.orderId });

  const curlCmd = [
    'curl -sf -X POST',
    `"${url}"`,
    `-H "Authorization: Bearer ${cfg.agentToken}"`,
    '-H "Content-Type: application/json"',
    `-d '${body}'`,
    '--max-time 30',
    '--retry 3',
    '--retry-delay 5',
  ].join(' ');

  try {
    const { stdout } = await execAsync(curlCmd, { timeout: 60_000 });
    logger.info(`[Step 8] Backend Antwort: ${stdout.trim()}`);
    logger.info('[Step 8] ✅ Provisioning abgeschlossen — Server ist bereit!');
  } catch (err: any) {
    // Callback-Fehler ist nicht fatal — Server läuft trotzdem.
    // Admin kann manuell den Status setzen.
    const msg = err?.stderr || err?.message || String(err);
    logger.warn(`[Step 8] Ready-Callback fehlgeschlagen (nicht fatal): ${msg}`);

    // Trotzdem als Fehler werfen damit Admin sieht: "finalize fehlgeschlagen"
    throw new Error(`Ready-Callback fehlgeschlagen: ${msg}`);
  }
}

export async function verifyFinalize(cfg: ProvisionConfig): Promise<void> {
  // Prüfen ob Backend den Ready-Callback bestätigt hat (installationStatus === 'complete')
  try {
    const res = execSync(
      `curl -sf --max-time 10 -H "Authorization: Bearer ${cfg.agentToken}" ` +
      `${cfg.backendApiUrl}/api/agent/status`,
      { timeout: 15_000 }
    ).toString();
    const data = JSON.parse(res);
    if (data?.installationStatus !== 'complete') {
      throw new Error(`Status nicht 'complete' — Backend meldet: ${data?.installationStatus}`);
    }
  } catch (err) {
    if (err instanceof Error && err.message.includes('nicht')) throw err;
    throw new Error(`Backend-Status-Check fehlgeschlagen: ${err instanceof Error ? err.message : String(err)}`);
  }
}
