/**
 * provision/steps/01-install-nginx.ts
 *
 * Step 1: Nginx + Certbot installieren, HTTP-only Config schreiben, starten.
 *
 * Idempotenz: Prüft ob nginx bereits läuft.
 *             apt-get install ist von sich aus idempotent.
 */

import * as fs       from 'fs';
import { ProvisionConfig } from '../types.js';
import { logger }          from '../../utils/logger.js';
import { safeExec }        from '../engine/safe-exec.js';

// ─── Idempotenz-Check ─────────────────────────────────────────────────────────

async function isNginxInstalled(): Promise<boolean> {
  const result = await safeExec('which', ['nginx'], { ignoreExitCode: true });
  return result.exitCode === 0;
}

// ─── Nginx HTTP-only Config ───────────────────────────────────────────────────
// Diese Config läuft nur auf Port 80 — damit Certbot den Domain-Check machen kann.
// Wird in Step 6 durch die SSL-Config ersetzt.

function buildHttpConfig(cfg: ProvisionConfig): string {
  return `# Prilog Nginx Config (HTTP-only — wird nach SSL durch SSL-Config ersetzt)
server {
    listen 80;
    server_name ${cfg.matrixDomain} ${cfg.webappDomain};

    # Certbot ACME Challenge
    location /.well-known/acme-challenge/ {
        root /var/www/html;
    }

    # Prilog Web Client
    location /web/ {
        alias /var/www/prilog-web-client/;
        try_files $uri $uri/ /web/index.html;
    }

    # Synapse proxy (ohne SSL zunächst)
    location / {
        proxy_pass http://127.0.0.1:8008;
        proxy_set_header X-Forwarded-For $remote_addr;
        proxy_set_header X-Forwarded-Proto http;
        proxy_set_header Host $host;
    }
}
`;
}

// ─── Step ─────────────────────────────────────────────────────────────────────

export async function stepInstallNginx(cfg: ProvisionConfig): Promise<void> {
  // ── Idempotenz: bereits installiert? ─────────────────────────────
  if (await isNginxInstalled()) {
    logger.info('[Step 1] Nginx bereits installiert — überspringe apt-get');
  } else {
    logger.info('[Step 1] Installiere Nginx + Certbot...');
    await safeExec(
      'apt-get', ['install', '-y', 'nginx', 'certbot', 'python3-certbot-nginx'],
      { timeout: 120_000 },
    );
    logger.info('[Step 1] Nginx + Certbot installiert');
  }

  // ── HTTP-only Config schreiben ────────────────────────────────────
  // Immer neu schreiben (idempotent — gleicher Inhalt bei gleichem Config)
  const configPath = '/etc/nginx/sites-available/prilog';
  const config     = buildHttpConfig(cfg);

  fs.mkdirSync('/etc/nginx/sites-available', { recursive: true });
  fs.writeFileSync(configPath, config, 'utf-8');
  logger.info('[Step 1] HTTP-Config geschrieben');

  // ── Site aktivieren ───────────────────────────────────────────────
  const enabledPath = '/etc/nginx/sites-enabled/prilog';
  if (!fs.existsSync(enabledPath)) {
    fs.symlinkSync(configPath, enabledPath);
  }

  // Default-Site deaktivieren (verhindert Konflikt)
  const defaultEnabled = '/etc/nginx/sites-enabled/default';
  if (fs.existsSync(defaultEnabled)) {
    fs.unlinkSync(defaultEnabled);
    logger.info('[Step 1] Default-Site deaktiviert');
  }

  // ── Nginx testen und (re)starten ──────────────────────────────────
  await safeExec('nginx', ['-t'], { timeout: 10_000 });

  // Nginx starten falls nicht läuft, sonst reload
  const activeResult = await safeExec('systemctl', ['is-active', 'nginx', '--quiet'], { ignoreExitCode: true });
  if (activeResult.exitCode === 0) {
    await safeExec('systemctl', ['reload', 'nginx'], { timeout: 15_000 });
    logger.info('[Step 1] Nginx reloaded');
  } else {
    await safeExec('systemctl', ['enable', 'nginx'], { timeout: 30_000 });
    await safeExec('systemctl', ['start', 'nginx'], { timeout: 30_000 });
    logger.info('[Step 1] Nginx gestartet');
  }
}

export async function verifyInstallNginx(_cfg: ProvisionConfig): Promise<void> {
  if (!(await isNginxInstalled())) {
    throw new Error('Nginx nicht installiert');
  }
  const nginxTest = await safeExec('nginx', ['-t'], { ignoreExitCode: true, timeout: 10_000 });
  if (nginxTest.exitCode !== 0) {
    throw new Error('Nginx Konfiguration ungültig (nginx -t fehlgeschlagen)');
  }
  const activeResult = await safeExec('systemctl', ['is-active', 'nginx'], { ignoreExitCode: true });
  if (activeResult.exitCode !== 0) {
    throw new Error('Nginx-Dienst läuft nicht');
  }
}
