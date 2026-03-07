/**
 * provision/steps/04-mount-volume.ts
 *
 * Hetzner Volume mounten via fstab — kein systemd Unit, kein \x2d Problem.
 */

import { execSync }  from 'child_process';
import { promisify } from 'util';
import { exec }      from 'child_process';
import * as fs       from 'fs';
import { ProvisionConfig } from '../types.js';
import { logger }          from '../../utils/logger.js';

const execAsync = promisify(exec);

const MOUNT_POINT = '/mnt/prilog-data';

function isVolumeMounted(): boolean {
  try {
    execSync(`mountpoint -q ${MOUNT_POINT}`, { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

export async function stepMountVolume(cfg: ProvisionConfig): Promise<void> {
  const device = `/dev/disk/by-id/scsi-0HC_Volume_${cfg.subdomain}`;

  if (isVolumeMounted()) {
    logger.info('[Step 04] Volume bereits gemountet — überspringe');
  } else {
    logger.info(`[Step 04] Mounte Volume ${device} → ${MOUNT_POINT}`);

    // Verzeichnis anlegen
    fs.mkdirSync(MOUNT_POINT, { recursive: true });

    // fstab Eintrag (idempotent)
    const fstabLine = `${device} ${MOUNT_POINT} ext4 discard,nofail,defaults 0 0`;
    const fstab = fs.readFileSync('/etc/fstab', 'utf-8');
    if (!fstab.includes(device)) {
      fs.appendFileSync('/etc/fstab', `\n${fstabLine}\n`, 'utf-8');
      logger.info('[Step 04] fstab Eintrag hinzugefügt');
    }

    // Mounten
    await execAsync(`mount -o discard,defaults ${device} ${MOUNT_POINT}`, { timeout: 30_000 });
    logger.info('[Step 04] Volume gemountet');
  }

  // ── Verzeichnisse anlegen (idempotent) ───────────────────────────
  for (const dir of [
    `${MOUNT_POINT}/postgres`,
    `${MOUNT_POINT}/synapse`,
    `${MOUNT_POINT}/backups`,
    `${MOUNT_POINT}/media`,
    '/opt/prilog',
    '/opt/prilog/scripts',
    '/etc/prilog',
    '/var/www/html',
    '/var/www/element',
  ]) {
    fs.mkdirSync(dir, { recursive: true });
  }

  logger.info('[Step 04] Verzeichnisse eingerichtet');
}

export async function verifyMountVolume(_cfg: ProvisionConfig): Promise<void> {
  if (!isVolumeMounted()) {
    throw new Error('Volume nicht gemountet nach Setup');
  }
  for (const dir of [`${MOUNT_POINT}/postgres`, `${MOUNT_POINT}/synapse`]) {
    try {
      execSync(`test -d ${dir}`, { stdio: 'ignore' });
    } catch {
      throw new Error(`Verzeichnis ${dir} fehlt nach Volume-Mount`);
    }
  }
}
