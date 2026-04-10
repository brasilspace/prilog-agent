"use strict";
/**
 * provision/steps/01-install-nginx.ts
 *
 * Step 1: Nginx + Certbot installieren, HTTP-only Config schreiben, starten.
 *
 * Idempotenz: Prüft ob nginx bereits läuft.
 *             apt-get install ist von sich aus idempotent.
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
exports.stepInstallNginx = stepInstallNginx;
exports.verifyInstallNginx = verifyInstallNginx;
const fs = __importStar(require("fs"));
const logger_js_1 = require("../../utils/logger.js");
const safe_exec_js_1 = require("../engine/safe-exec.js");
// ─── Idempotenz-Check ─────────────────────────────────────────────────────────
async function isNginxInstalled() {
    const result = await (0, safe_exec_js_1.safeExec)('which', ['nginx'], { ignoreExitCode: true });
    return result.exitCode === 0;
}
// ─── Nginx HTTP-only Config ───────────────────────────────────────────────────
// Diese Config läuft nur auf Port 80 — damit Certbot den Domain-Check machen kann.
// Wird in Step 6 durch die SSL-Config ersetzt.
function buildHttpConfig(cfg) {
    return `# Prilog Nginx Config (HTTP-only — wird nach SSL durch SSL-Config ersetzt)
server {
    listen 80;
    server_name ${cfg.matrixDomain} ${cfg.webappDomain};

    # Certbot ACME Challenge
    location /.well-known/acme-challenge/ {
        root /var/www/html;
    }

    # Matrix Client + Federation API
    location ~ ^(/_matrix|/_synapse/client) {
        proxy_pass http://127.0.0.1:8008;
        proxy_set_header X-Forwarded-For $remote_addr;
        proxy_set_header X-Forwarded-Proto http;
        proxy_set_header Host $host;
    }

    # Prilog Web Client (SPA fallback)
    root /var/www/prilog-web-client;
    index index.html;
    location / {
        try_files $uri $uri/ /index.html;
    }
}
`;
}
// ─── Step ─────────────────────────────────────────────────────────────────────
async function stepInstallNginx(cfg) {
    // ── Idempotenz: bereits installiert? ─────────────────────────────
    if (await isNginxInstalled()) {
        logger_js_1.logger.info('[Step 1] Nginx bereits installiert — überspringe apt-get');
    }
    else {
        logger_js_1.logger.info('[Step 1] Installiere Nginx + Certbot...');
        await (0, safe_exec_js_1.safeExec)('apt-get', ['install', '-y', 'nginx', 'certbot', 'python3-certbot-nginx'], { timeout: 120_000 });
        logger_js_1.logger.info('[Step 1] Nginx + Certbot installiert');
    }
    // ── HTTP-only Config schreiben ────────────────────────────────────
    // Immer neu schreiben (idempotent — gleicher Inhalt bei gleichem Config)
    const configPath = '/etc/nginx/sites-available/prilog';
    const config = buildHttpConfig(cfg);
    fs.mkdirSync('/etc/nginx/sites-available', { recursive: true });
    fs.writeFileSync(configPath, config, 'utf-8');
    logger_js_1.logger.info('[Step 1] HTTP-Config geschrieben');
    // ── MIME-Types patchen: .mjs als application/javascript ────────────
    // Nginx's Standard-mime.types mappt .mjs nicht. Ohne diesen Patch werden
    // ES-Module-Worker (z.B. der PDF.js-Worker fuer die PDF-Vorschau im Chat)
    // mit content-type: application/octet-stream ausgeliefert — und der
    // Browser lehnt ab, weil Module-Worker JavaScript-MIME brauchen.
    // Der Patch ist idempotent: wir fuegen "mjs" nur hinzu wenn's fehlt.
    try {
        const mimeTypesPath = '/etc/nginx/mime.types';
        if (fs.existsSync(mimeTypesPath)) {
            const mime = fs.readFileSync(mimeTypesPath, 'utf-8');
            if (!/application\/javascript\s+[^;]*\bmjs\b/.test(mime)) {
                const patched = mime.replace(/(application\/javascript\s+)([^;]*?);/, '$1$2 mjs;');
                if (patched !== mime) {
                    fs.writeFileSync(mimeTypesPath, patched, 'utf-8');
                    logger_js_1.logger.info('[Step 1] mime.types: .mjs → application/javascript hinzugefuegt');
                }
            }
        }
    }
    catch (err) {
        // Nicht-kritisch, loggen und weiter
        logger_js_1.logger.warn('[Step 1] mime.types Patch fehlgeschlagen', { err });
    }
    // ── Site aktivieren ───────────────────────────────────────────────
    const enabledPath = '/etc/nginx/sites-enabled/prilog';
    if (!fs.existsSync(enabledPath)) {
        fs.symlinkSync(configPath, enabledPath);
    }
    // Default-Site deaktivieren (verhindert Konflikt)
    const defaultEnabled = '/etc/nginx/sites-enabled/default';
    if (fs.existsSync(defaultEnabled)) {
        fs.unlinkSync(defaultEnabled);
        logger_js_1.logger.info('[Step 1] Default-Site deaktiviert');
    }
    // ── Nginx testen und (re)starten ──────────────────────────────────
    await (0, safe_exec_js_1.safeExec)('nginx', ['-t'], { timeout: 10_000 });
    // Nginx starten falls nicht läuft, sonst reload
    const activeResult = await (0, safe_exec_js_1.safeExec)('systemctl', ['is-active', 'nginx', '--quiet'], { ignoreExitCode: true });
    if (activeResult.exitCode === 0) {
        await (0, safe_exec_js_1.safeExec)('systemctl', ['reload', 'nginx'], { timeout: 15_000 });
        logger_js_1.logger.info('[Step 1] Nginx reloaded');
    }
    else {
        await (0, safe_exec_js_1.safeExec)('systemctl', ['enable', 'nginx'], { timeout: 30_000 });
        await (0, safe_exec_js_1.safeExec)('systemctl', ['start', 'nginx'], { timeout: 30_000 });
        logger_js_1.logger.info('[Step 1] Nginx gestartet');
    }
}
async function verifyInstallNginx(_cfg) {
    if (!(await isNginxInstalled())) {
        throw new Error('Nginx nicht installiert');
    }
    const nginxTest = await (0, safe_exec_js_1.safeExec)('nginx', ['-t'], { ignoreExitCode: true, timeout: 10_000 });
    if (nginxTest.exitCode !== 0) {
        throw new Error('Nginx Konfiguration ungültig (nginx -t fehlgeschlagen)');
    }
    const activeResult = await (0, safe_exec_js_1.safeExec)('systemctl', ['is-active', 'nginx'], { ignoreExitCode: true });
    if (activeResult.exitCode !== 0) {
        throw new Error('Nginx-Dienst läuft nicht');
    }
}
