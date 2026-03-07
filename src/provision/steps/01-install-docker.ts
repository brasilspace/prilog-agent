/**
 * provision/steps/01-install-docker.ts
 *
 * Docker CE + Compose Plugin installieren.
 * Idempotent: prüft ob docker bereits installiert ist.
 */

import { execSync }   from 'child_process';
import { promisify }  from 'util';
import { exec }       from 'child_process';
import { ProvisionConfig } from '../types.js';
import { logger }          from '../../utils/logger.js';

const execAsync = promisify(exec);

function isDockerInstalled(): boolean {
  try {
    execSync('docker --version', { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

export async function stepInstallDocker(_cfg: ProvisionConfig): Promise<void> {
  if (isDockerInstalled()) {
    logger.info('[Step 01] Docker bereits installiert — überspringe');
    return;
  }

  logger.info('[Step 01] Installiere Docker...');

  await execAsync(
    'apt-get install -y apt-transport-https ca-certificates curl gnupg lsb-release',
    { timeout: 120_000 }
  );

  await execAsync(
    'curl -fsSL https://download.docker.com/linux/ubuntu/gpg | gpg --dearmor -o /usr/share/keyrings/docker-archive-keyring.gpg',
    { timeout: 30_000 }
  );

  await execAsync(
    'echo "deb [arch=amd64 signed-by=/usr/share/keyrings/docker-archive-keyring.gpg] https://download.docker.com/linux/ubuntu $(lsb_release -cs) stable" > /etc/apt/sources.list.d/docker.list',
    { shell: '/bin/bash', timeout: 10_000 }
  );

  await execAsync('apt-get update -qq', { timeout: 60_000 });

  await execAsync(
    'apt-get install -y docker-ce docker-ce-cli containerd.io docker-compose-plugin',
    { timeout: 180_000 }
  );

  await execAsync('systemctl enable docker && systemctl start docker', { timeout: 30_000 });

  logger.info('[Step 01] Docker installiert und gestartet');
}
