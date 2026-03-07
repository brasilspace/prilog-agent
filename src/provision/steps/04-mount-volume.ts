/**
 * provision/steps/04-mount-volume.ts
 *
 * Hetzner Volume mounten und Verzeichnisstruktur anlegen.
 * Idempotent: prüft ob Volume bereits gemountet ist.
 */

import { execSync }   from 'child_process';
import { promisify }  from 'util';
import { exec }       from 'child_process';
import * as fs        from 'fs';
import { ProvisionConfig } from '../types.js';
import { logger }          from '../../utils/logger.js';

const execAsync = promisify(exec);

function isVolumeMounted(): boolean {
  try {
    const out = execSync('mountpoint -q /mnt/prilog-data && echo yes', { encoding: 'utf-8' });
    return out.trim() === 'yes';
  } catch {
    return false;
  }
}

function buildMountUnit(cfg: ProvisionConfig): string {
  return `[Unit]
Description=Prilog Data Volume
After=local-fs.target

[Mount]
What=/dev/disk/by-id/scsi-0HC_Volume_${cfg.subdomain}
Where=/mnt/prilog-data
Type=ext4
Options=discard,defaults

[Install]
WantedBy=multi-user.target
`;
}

export async function stepMountVolume(cfg: ProvisionConfig): Promise<void> {
  if (isVolumeMounted()) {
    logger.info('[Step 04] Volume bereits gemountet — überspringe');
  } else {
    logger.info('[Step 04] Schreibe systemd Mount-Unit...');

    // Bindestriche in systemd Unit-Namen müssen als \x2d escaped werden
    const unitName = 'mnt-prilog\\x2ddata.mount';
    const unitPath = `/etc/systemd/system/${unitName}`;

    fs.writeFileSync(unitPath, buildMountUnit(cfg), 'utf-8');

    await execAsync('systemctl daemon-reload', { timeout: 15_000 });
    await execAsync('systemctl enable mnt-prilog\\x2ddata.mount', { timeout: 10_000 });
    await execAsync('systemctl start mnt-prilog\\x2ddata.mount', { timeout: 30_000 });

    logger.info('[Step 04] Volume gemountet');
  }

  // ── Verzeichnisse anlegen (immer, idempotent) ─────────────────────
  logger.info('[Step 04] Verzeichnisse anlegen...');

  const dirs = [
    '/mnt/prilog-data/postgres',
    '/mnt/prilog-data/synapse',
    '/mnt/prilog-data/backups',
    '/mnt/prilog-data/media',
    '/opt/prilog',
    '/opt/prilog/scripts',
    '/etc/prilog',
    '/var/www/html',
    '/var/www/element',
  ];

  for (const dir of dirs) {
    fs.mkdirSync(dir, { recursive: true });
  }

  // ── Docker Compose Autostart nach Reboot ─────────────────────────
  const composeService = `[Unit]
Description=Prilog Docker Compose
Requires=docker.service mnt-prilog\\x2ddata.mount
After=docker.service mnt-prilog\\x2ddata.mount

[Service]
Type=oneshot
RemainAfterExit=yes
WorkingDirectory=/opt/prilog
ExecStart=/usr/bin/docker compose up -d
ExecStop=/usr/bin/docker compose down
TimeoutStartSec=300

[Install]
WantedBy=multi-user.target
`;

  fs.writeFileSync('/etc/systemd/system/prilog-compose.service', composeService, 'utf-8');
  await execAsync('systemctl daemon-reload', { timeout: 15_000 });
  await execAsync('systemctl enable prilog-compose.service', { timeout: 10_000 });

  logger.info('[Step 04] Verzeichnisse und Autostart-Service eingerichtet');
}
