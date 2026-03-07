/**
 * provision/steps/01-install-nginx.ts
 *
 * Step 1: Nginx + Certbot installieren, HTTP-only Config schreiben, starten.
 *
 * Idempotenz: Prüft ob nginx bereits läuft.
 *             apt-get install ist von sich aus idempotent.
 */

import { execSync } from 'child_process';
import { exec }     from 'child_process';
import { promisify } from 'util';
import * as fs       from 'fs';
import { ProvisionConfig } from '../types.js';
import { logger }          from '../../utils/logger.js';

const execAsync = promisify(exec);

// ─── Idempotenz-Check ─────────────────────────────────────────────────────────

function isNginxInstalled(): boolean {
  try {
    execSync('which nginx', { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
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
  if (isNginxInstalled()) {
    logger.info('[Step 1] Nginx bereits installiert — überspringe apt-get');
  } else {
    logger.info('[Step 1] Installiere Nginx + Certbot...');
    await execAsync(
      'apt-get install -y nginx certbot python3-certbot-nginx',
      { timeout: 120_000 }
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
  await execAsync('nginx -t', { timeout: 10_000 });

  // Nginx starten falls nicht läuft, sonst reload
  try {
    execSync('systemctl is-active nginx --quiet');
    await execAsync('systemctl reload nginx', { timeout: 15_000 });
    logger.info('[Step 1] Nginx reloaded');
  } catch {
    await execAsync('systemctl enable nginx && systemctl start nginx', { timeout: 30_000 });
    logger.info('[Step 1] Nginx gestartet');
  }
}

export async function verifyInstallNginx(_cfg: ProvisionConfig): Promise<void> {
  if (!isNginxInstalled()) {
    throw new Error('Nginx nicht installiert');
  }
  try {
    execSync('nginx -t', { stdio: 'ignore', timeout: 10_000 });
  } catch {
    throw new Error('Nginx Konfiguration ungültig (nginx -t fehlgeschlagen)');
  }
  try {
    execSync('systemctl is-active nginx', { stdio: 'ignore' });
  } catch {
    throw new Error('Nginx-Dienst läuft nicht');
  }
}
