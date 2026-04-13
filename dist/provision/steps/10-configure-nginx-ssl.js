"use strict";
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
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.stepConfigureNginxSsl = stepConfigureNginxSsl;
exports.verifyConfigureNginxSsl = verifyConfigureNginxSsl;
const fs = __importStar(require("fs"));
const logger_js_1 = require("../../utils/logger.js");
const safe_exec_js_1 = require("../engine/safe-exec.js");
const CONFIG_PATH = '/etc/nginx/sites-available/prilog';
// ─── SSL Config Template ──────────────────────────────────────────────────────
function buildSslConfig(cfg) {
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

    # Matrix Client + Federation API
    location ~ ^(/_matrix|/_synapse/client) {
        proxy_pass http://127.0.0.1:8008;
        proxy_set_header X-Forwarded-For $remote_addr;
        proxy_set_header X-Forwarded-Proto https;
        proxy_set_header Host $host;
        proxy_read_timeout 600s;
    }

    # SSE-Stream fuer Echtzeit-Events — muss VOR /api/ stehen (spezifischer).
    # Erfordert lange Timeouts, kein Buffering, HTTP/1.1 keep-alive.
    location /api/platform/v1/workflow/events/stream {
        proxy_pass https://api.prilog.chat/api/platform/v1/workflow/events/stream;
        proxy_set_header Host api.prilog.chat;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto https;
        proxy_ssl_server_name on;
        proxy_http_version 1.1;
        proxy_set_header Connection "";
        proxy_buffering off;
        proxy_cache off;
        chunked_transfer_encoding off;
        proxy_read_timeout 24h;
        proxy_send_timeout 24h;
    }

    # Platform API proxy to central backend
    location /api/ {
        proxy_pass https://api.prilog.chat/api/;
        proxy_set_header Host api.prilog.chat;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto https;
        proxy_ssl_server_name on;
        proxy_read_timeout 30s;
    }

    # MinIO S3 proxy for presigned URLs
    location /s3/ {
        rewrite ^/s3/(.*) /$1 break;
        proxy_pass http://127.0.0.1:9000;
        proxy_set_header Host ${cfg.matrixDomain};
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto https;
        client_max_body_size 200m;
    }

    # Prilog Web Client (SPA fallback)
    root /var/www/prilog-web-client;
    index index.html;
    location / {
        try_files $uri $uri/ /index.html;
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
function isSslConfigActive() {
    try {
        const content = fs.readFileSync(CONFIG_PATH, 'utf-8');
        return content.includes('ssl_certificate') && content.includes('443 ssl');
    }
    catch {
        return false;
    }
}
// ─── Step ─────────────────────────────────────────────────────────────────────
async function stepConfigureNginxSsl(cfg) {
    // ── Idempotenz ─────────────────────────────────────────────────────
    if (isSslConfigActive()) {
        // Config neu schreiben ist sicher (idempotent) und stellt sicher
        // dass alles korrekt ist — kurzes nginx reload schadet nicht
        logger_js_1.logger.info('[Step 6] SSL-Config bereits aktiv — aktualisiere und reloade');
    }
    else {
        logger_js_1.logger.info('[Step 6] Schreibe SSL-Config...');
    }
    // ── SSL-Config schreiben ──────────────────────────────────────────
    const config = buildSslConfig(cfg);
    fs.writeFileSync(CONFIG_PATH, config, 'utf-8');
    logger_js_1.logger.info('[Step 6] SSL-Config geschrieben');
    // ── Config testen ─────────────────────────────────────────────────
    try {
        await (0, safe_exec_js_1.safeExec)('nginx', ['-t'], { timeout: 10_000 });
    }
    catch (err) {
        throw new Error(`Nginx Config-Test fehlgeschlagen: ${err?.message}`);
    }
    // ── Nginx reloaden ────────────────────────────────────────────────
    await (0, safe_exec_js_1.safeExec)('systemctl', ['reload', 'nginx'], { timeout: 15_000 });
    logger_js_1.logger.info('[Step 6] Nginx mit SSL-Config reloaded');
}
async function verifyConfigureNginxSsl(cfg) {
    const nginxTest = await (0, safe_exec_js_1.safeExec)('nginx', ['-t'], { ignoreExitCode: true, timeout: 10_000 });
    if (nginxTest.exitCode !== 0) {
        throw new Error('Nginx SSL-Konfiguration ungültig (nginx -t fehlgeschlagen)');
    }
    // HTTPS-Erreichbarkeit prüfen — jede Antwort (auch 3xx/4xx) ist OK
    for (const domain of [cfg.matrixDomain, cfg.webappDomain]) {
        const result = await (0, safe_exec_js_1.safeExec)('curl', ['-s', '--max-time', '10', '-o', '/dev/null', '-w', '%{http_code}', `https://${domain}`], { timeout: 15_000, ignoreExitCode: true });
        const code = result.stdout.trim();
        if (!code || code === '000') {
            throw new Error(`https://${domain} nicht erreichbar nach SSL-Konfiguration: Keine Verbindung`);
        }
    }
}
