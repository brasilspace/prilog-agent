/**
 * provision/steps/03-setup-tailscale.ts
 *
 * Tailscale installieren und mit dem Prilog Tailnet verbinden.
 * Idempotent: prüft ob Tailscale bereits verbunden ist.
 */

import { execSync }   from 'child_process';
import { promisify }  from 'util';
import { exec }       from 'child_process';
import { ProvisionConfig } from '../types.js';
import { logger }          from '../../utils/logger.js';

const execAsync = promisify(exec);

function isTailscaleConnected(): boolean {
  try {
    const out = execSync('tailscale status', { encoding: 'utf-8' });
    return out.includes('prilog-');
  } catch {
    return false;
  }
}

function isTailscaleInstalled(): boolean {
  try {
    execSync('which tailscale', { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

export async function stepSetupTailscale(cfg: ProvisionConfig): Promise<void> {
  if (isTailscaleConnected()) {
    logger.info('[Step 03] Tailscale bereits verbunden — überspringe');
    return;
  }

  if (!isTailscaleInstalled()) {
    logger.info('[Step 03] Installiere Tailscale...');
    await execAsync('curl -fsSL https://tailscale.com/install.sh | sh', {
      shell: '/bin/bash',
      timeout: 120_000,
    });
  }

  logger.info(`[Step 03] Verbinde mit Tailnet als prilog-${cfg.subdomain}...`);
  await execAsync(
    `tailscale up --authkey=${cfg.tailscaleAuthKey} --hostname=prilog-${cfg.subdomain} --accept-routes`,
    { timeout: 60_000 }
  );

  logger.info('[Step 03] Tailscale verbunden');
}

export async function verifySetupTailscale(_cfg: ProvisionConfig): Promise<void> {
  if (!isTailscaleConnected()) {
    throw new Error('Tailscale nicht verbunden nach Setup (tailscale status zeigt nicht "Connected")');
  }
}
