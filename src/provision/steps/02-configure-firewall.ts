/**
 * provision/steps/02-configure-firewall.ts
 *
 * UFW Firewall konfigurieren.
 * Idempotent: ufw-Regeln können mehrfach gesetzt werden.
 */

import { promisify } from 'util';
import { exec }      from 'child_process';
import { execSync }  from 'child_process';
import { ProvisionConfig } from '../types.js';
import { logger }          from '../../utils/logger.js';

const execAsync = promisify(exec);

function isUfwEnabled(): boolean {
  try {
    const out = execSync('ufw status', { encoding: 'utf-8' });
    return out.includes('Status: active');
  } catch {
    return false;
  }
}

export async function stepConfigureFirewall(_cfg: ProvisionConfig): Promise<void> {
  logger.info('[Step 02] Konfiguriere UFW Firewall...');

  // fail2ban installieren
  await execAsync('apt-get install -y ufw fail2ban', { timeout: 60_000 });

  if (isUfwEnabled()) {
    logger.info('[Step 02] UFW bereits aktiv — überspringe');
    return;
  }

  await execAsync('ufw default deny incoming',  { timeout: 10_000 });
  await execAsync('ufw default allow outgoing', { timeout: 10_000 });
  await execAsync('ufw allow 22/tcp',   { timeout: 10_000 });
  await execAsync('ufw allow 80/tcp',   { timeout: 10_000 });
  await execAsync('ufw allow 443/tcp',  { timeout: 10_000 });
  await execAsync('ufw allow 8448/tcp', { timeout: 10_000 });
  await execAsync('ufw allow in on tailscale0', { timeout: 10_000 });
  await execAsync('ufw --force enable', { timeout: 15_000 });

  logger.info('[Step 02] Firewall konfiguriert und aktiviert');
}
