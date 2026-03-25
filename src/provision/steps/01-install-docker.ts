/**
 * provision/steps/01-install-docker.ts
 *
 * Docker CE + Compose Plugin installieren.
 * Idempotent: prüft ob docker bereits installiert ist.
 */

import { ProvisionConfig } from '../types.js';
import { logger }          from '../../utils/logger.js';
import { safeExec }        from '../engine/safe-exec.js';

async function isDockerInstalled(): Promise<boolean> {
  const result = await safeExec('docker', ['--version'], { ignoreExitCode: true });
  return result.exitCode === 0;
}

export async function stepInstallDocker(_cfg: ProvisionConfig): Promise<void> {
  if (await isDockerInstalled()) {
    logger.info('[Step 01] Docker bereits installiert — überspringe');
    return;
  }

  logger.info('[Step 01] Installiere Docker...');

  await safeExec(
    'apt-get', ['install', '-y', 'apt-transport-https', 'ca-certificates', 'curl', 'gnupg', 'lsb-release'],
    { timeout: 120_000 },
  );

  // Shell pipe for GPG key — hardcoded command, no user input
  await safeExec(
    'bash', ['-c', 'curl -fsSL https://download.docker.com/linux/ubuntu/gpg | gpg --dearmor -o /usr/share/keyrings/docker-archive-keyring.gpg'],
    { timeout: 30_000 },
  );

  // Add Docker repo — needs shell for $(lsb_release -cs)
  await safeExec(
    'bash', ['-c', 'echo "deb [arch=amd64 signed-by=/usr/share/keyrings/docker-archive-keyring.gpg] https://download.docker.com/linux/ubuntu $(lsb_release -cs) stable" > /etc/apt/sources.list.d/docker.list'],
    { timeout: 10_000 },
  );

  await safeExec('apt-get', ['update', '-qq'], { timeout: 60_000 });

  await safeExec(
    'apt-get', ['install', '-y', 'docker-ce', 'docker-ce-cli', 'containerd.io', 'docker-compose-plugin'],
    { timeout: 180_000 },
  );

  await safeExec('systemctl', ['enable', 'docker'], { timeout: 30_000 });
  await safeExec('systemctl', ['start', 'docker'], { timeout: 30_000 });

  logger.info('[Step 01] Docker installiert und gestartet');
}

export async function verifyInstallDocker(_cfg: ProvisionConfig): Promise<void> {
  const dockerResult = await safeExec('docker', ['--version'], { ignoreExitCode: true });
  if (dockerResult.exitCode !== 0) {
    throw new Error('Docker oder Docker Compose nicht verfügbar nach Installation');
  }
  const composeResult = await safeExec('docker', ['compose', 'version'], { ignoreExitCode: true });
  if (composeResult.exitCode !== 0) {
    throw new Error('Docker oder Docker Compose nicht verfügbar nach Installation');
  }
  const activeResult = await safeExec('systemctl', ['is-active', 'docker'], { ignoreExitCode: true });
  if (activeResult.exitCode !== 0) {
    throw new Error('Docker-Dienst läuft nicht (systemctl is-active docker fehlgeschlagen)');
  }
}
