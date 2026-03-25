/**
 * provision/steps/02-configure-firewall.ts
 *
 * UFW Firewall konfigurieren.
 * Idempotent: ufw-Regeln können mehrfach gesetzt werden.
 */

import { ProvisionConfig } from '../types.js';
import { logger }          from '../../utils/logger.js';
import { safeExec }        from '../engine/safe-exec.js';

async function isUfwEnabled(): Promise<boolean> {
  const result = await safeExec('ufw', ['status'], { ignoreExitCode: true });
  return result.exitCode === 0 && result.stdout.includes('Status: active');
}

export async function stepConfigureFirewall(_cfg: ProvisionConfig): Promise<void> {
  logger.info('[Step 02] Konfiguriere UFW Firewall...');

  // fail2ban installieren
  await safeExec('apt-get', ['install', '-y', 'ufw', 'fail2ban'], { timeout: 60_000 });

  if (await isUfwEnabled()) {
    logger.info('[Step 02] UFW bereits aktiv — überspringe');
    return;
  }

  await safeExec('ufw', ['default', 'deny', 'incoming'],  { timeout: 10_000 });
  await safeExec('ufw', ['default', 'allow', 'outgoing'], { timeout: 10_000 });
  await safeExec('ufw', ['allow', '22/tcp'],   { timeout: 10_000 });
  await safeExec('ufw', ['allow', '80/tcp'],   { timeout: 10_000 });
  await safeExec('ufw', ['allow', '443/tcp'],  { timeout: 10_000 });
  await safeExec('ufw', ['allow', '8448/tcp'], { timeout: 10_000 });
  await safeExec('ufw', ['allow', 'in', 'on', 'tailscale0'], { timeout: 10_000 });
  await safeExec('ufw', ['--force', 'enable'], { timeout: 15_000 });

  logger.info('[Step 02] Firewall konfiguriert und aktiviert');
}

export async function verifyConfigureFirewall(_cfg: ProvisionConfig): Promise<void> {
  const result = await safeExec('ufw', ['status'], { ignoreExitCode: true, timeout: 5_000 });
  if (result.exitCode !== 0 || !result.stdout.includes('Status: active')) {
    throw new Error(`Firewall-Prüfung fehlgeschlagen: UFW nicht aktiv`);
  }
}
