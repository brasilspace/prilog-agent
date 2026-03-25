/**
 * provision/steps/03-setup-tailscale.ts
 *
 * Tailscale installieren und mit dem Prilog Tailnet verbinden.
 * Idempotent: prüft ob Tailscale bereits verbunden ist.
 */

import { ProvisionConfig } from '../types.js';
import { logger }          from '../../utils/logger.js';
import { safeExec }        from '../engine/safe-exec.js';

async function isTailscaleConnected(): Promise<boolean> {
  const result = await safeExec('tailscale', ['status'], { ignoreExitCode: true });
  return result.exitCode === 0 && result.stdout.includes('prilog-');
}

async function isTailscaleInstalled(): Promise<boolean> {
  const result = await safeExec('which', ['tailscale'], { ignoreExitCode: true });
  return result.exitCode === 0;
}

export async function stepSetupTailscale(cfg: ProvisionConfig): Promise<void> {
  if (await isTailscaleConnected()) {
    logger.info('[Step 03] Tailscale bereits verbunden — überspringe');
    return;
  }

  if (!(await isTailscaleInstalled())) {
    logger.info('[Step 03] Installiere Tailscale...');
    // Shell pipe — hardcoded install script, no user input
    await safeExec('bash', ['-c', 'curl -fsSL https://tailscale.com/install.sh | sh'], {
      timeout: 120_000,
    });
  }

  logger.info(`[Step 03] Verbinde mit Tailnet als prilog-${cfg.subdomain}...`);
  await safeExec(
    'tailscale', ['up', `--authkey=${cfg.tailscaleAuthKey}`, `--hostname=prilog-${cfg.subdomain}`, '--accept-routes'],
    { timeout: 60_000 },
  );

  logger.info('[Step 03] Tailscale verbunden');
}

export async function verifySetupTailscale(_cfg: ProvisionConfig): Promise<void> {
  if (!(await isTailscaleConnected())) {
    throw new Error('Tailscale nicht verbunden nach Setup (tailscale status zeigt nicht "Connected")');
  }
}
