/**
 * provision/steps/06-configure-nginx-ssl.ts
 *
 * Step 6: Nginx SSL-Config aktivieren und nginx reloaden.
 *
 * Ersetzt die HTTP-only Config (Step 1) durch die vollständige SSL-Config:
 *  - matrixDomain: Synapse Proxy (Port 8008)
 *  - webappDomain: Element Web (statisch) + .well-known Matrix-Config
 *
 * Idempotenz: Prüft ob SSL-Config bereits aktiv.
 */

import * as fs        from 'fs';
import { ProvisionConfig } from '../types.js';
import { logger }          from '../../utils/logger.js';
import { safeExec }        from '../engine/safe-exec.js';

const CONFIG_PATH = '/etc/nginx/sites-available/prilog';

// ─── SSL Config Template ──────────────────────────────────────────────────────

function buildSslConfig(cfg: ProvisionConfig): string {
  return `# Prilog Nginx Config (SSL) — generiert von prilog-agent
# matrix domain: ${cfg.matrixDomain}
# webapp domain: ${cfg.webappDomain}

# HTTP → HTTPS Redirect
server {
    listen 80;
    server_name ${cfg.matrixDomain} ${cfg.webappDomain};

    location /.well-known/acme-challenge/ {
        root /var/www/html;
    }

    location / {
        return 301 https://$host$request_uri;
    }
}

# Matrix Synapse — ${cfg.matrixDomain}
server {
    listen 443 ssl http2;
    server_name ${cfg.matrixDomain};

    ssl_certificate     /etc/letsencrypt/live/${cfg.matrixDomain}/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/${cfg.matrixDomain}/privkey.pem;
    ssl_protocols       TLSv1.2 TLSv1.3;
    ssl_ciphers         HIGH:!aNULL:!MD5;

    client_max_body_size ${cfg.maxUploadSize}m;

    # Prilog Web Client
    location /web/ {
        alias /var/www/prilog-web-client/;
        try_files $uri $uri/ /web/index.html;
    }

    # Matrix Client + Federation API
    location ~ ^(/_matrix|/_synapse/client) {
        proxy_pass http://127.0.0.1:8008;
        proxy_set_header X-Forwarded-For $remote_addr;
        proxy_set_header X-Forwarded-Proto https;
        proxy_set_header Host $host;
        proxy_read_timeout 600s;
    }

    # Root → Web Client redirect
    location = / {
        return 302 /web/;
    }

    # Everything else → Synapse (Federation etc.)
    location / {
        proxy_pass http://127.0.0.1:8008;
        proxy_set_header X-Forwarded-For $remote_addr;
        proxy_set_header X-Forwarded-Proto https;
        proxy_set_header Host $host;
        proxy_read_timeout 600s;
    }
}

# Matrix Federation Port
server {
    listen 8448 ssl http2;
    server_name ${cfg.matrixDomain};

    ssl_certificate     /etc/letsencrypt/live/${cfg.matrixDomain}/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/${cfg.matrixDomain}/privkey.pem;
    ssl_protocols       TLSv1.2 TLSv1.3;
    ssl_ciphers         HIGH:!aNULL:!MD5;

    location / {
        proxy_pass http://127.0.0.1:8008;
        proxy_set_header X-Forwarded-For $remote_addr;
        proxy_set_header X-Forwarded-Proto https;
        proxy_set_header Host $host;
        proxy_read_timeout 600s;
    }
}

# Element Web — ${cfg.webappDomain}
server {
    listen 443 ssl http2;
    server_name ${cfg.webappDomain};

    ssl_certificate     /etc/letsencrypt/live/${cfg.webappDomain}/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/${cfg.webappDomain}/privkey.pem;
    ssl_protocols       TLSv1.2 TLSv1.3;
    ssl_ciphers         HIGH:!aNULL:!MD5;

    # Element Web statische Dateien
    root  /var/www/element;
    index index.html;

    # .well-known Matrix Federation Discovery
    location /.well-known/matrix/server {
        default_type application/json;
        return 200 '{"m.server": "${cfg.matrixDomain}:443"}';
        add_header Access-Control-Allow-Origin *;
    }

    location /.well-known/matrix/client {
        default_type application/json;
        return 200 '{"m.homeserver": {"base_url": "https://${cfg.matrixDomain}"}}';
        add_header Access-Control-Allow-Origin *;
    }

    location / {
        try_files $uri $uri/ /index.html;
    }
}
`;
}

// ─── Idempotenz-Check ─────────────────────────────────────────────────────────

function isSslConfigActive(): boolean {
  try {
    const content = fs.readFileSync(CONFIG_PATH, 'utf-8');
    return content.includes('ssl_certificate') && content.includes('443 ssl');
  } catch {
    return false;
  }
}

// ─── Step ─────────────────────────────────────────────────────────────────────

export async function stepConfigureNginxSsl(cfg: ProvisionConfig): Promise<void> {
  // ── Idempotenz ─────────────────────────────────────────────────────
  if (isSslConfigActive()) {
    // Config neu schreiben ist sicher (idempotent) und stellt sicher
    // dass alles korrekt ist — kurzes nginx reload schadet nicht
    logger.info('[Step 6] SSL-Config bereits aktiv — aktualisiere und reloade');
  } else {
    logger.info('[Step 6] Schreibe SSL-Config...');
  }

  // ── SSL-Config schreiben ──────────────────────────────────────────
  const config = buildSslConfig(cfg);
  fs.writeFileSync(CONFIG_PATH, config, 'utf-8');
  logger.info('[Step 6] SSL-Config geschrieben');

  // ── Config testen ─────────────────────────────────────────────────
  try {
    await safeExec('nginx', ['-t'], { timeout: 10_000 });
  } catch (err: any) {
    throw new Error(`Nginx Config-Test fehlgeschlagen: ${err?.message}`);
  }

  // ── Nginx reloaden ────────────────────────────────────────────────
  await safeExec('systemctl', ['reload', 'nginx'], { timeout: 15_000 });
  logger.info('[Step 6] Nginx mit SSL-Config reloaded');
}

export async function verifyConfigureNginxSsl(cfg: ProvisionConfig): Promise<void> {
  const nginxTest = await safeExec('nginx', ['-t'], { ignoreExitCode: true, timeout: 10_000 });
  if (nginxTest.exitCode !== 0) {
    throw new Error('Nginx SSL-Konfiguration ungültig (nginx -t fehlgeschlagen)');
  }
  // HTTPS-Erreichbarkeit prüfen — jede Antwort (auch 3xx/4xx) ist OK
  for (const domain of [cfg.matrixDomain, cfg.webappDomain]) {
    const result = await safeExec('curl', ['-s', '--max-time', '10', '-o', '/dev/null', '-w', '%{http_code}', `https://${domain}`], { timeout: 15_000, ignoreExitCode: true });
    const code = result.stdout.trim();
    if (!code || code === '000') {
      throw new Error(`https://${domain} nicht erreichbar nach SSL-Konfiguration: Keine Verbindung`);
    }
  }
}
