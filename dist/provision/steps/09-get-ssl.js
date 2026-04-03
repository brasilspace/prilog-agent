"use strict";
/**
 * provision/steps/05-get-ssl.ts
 *
 * Step 5: SSL-Zertifikate via Certbot holen.
 *
 * Holt Zertifikate für matrixDomain UND webappDomain.
 * Nginx muss bereits laufen und auf Port 80 erreichbar sein (Step 1).
 * DNS muss bereits propagiert sein (setzt Backend beim Provisionieren).
 *
 * Idempotenz: Prüft ob Zertifikat bereits vorhanden.
 *             Certbot --keep-until-expiring verhindert unnötige Neuausstellung.
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
exports.stepGetSsl = stepGetSsl;
exports.verifyGetSsl = verifyGetSsl;
const fs = __importStar(require("fs"));
const logger_js_1 = require("../../utils/logger.js");
const safe_exec_js_1 = require("../engine/safe-exec.js");
// ─── Idempotenz-Check ─────────────────────────────────────────────────────────
function certExists(domain) {
    const certPath = `/etc/letsencrypt/live/${domain}/fullchain.pem`;
    return fs.existsSync(certPath);
}
// ─── DNS Propagation Check ────────────────────────────────────────────────────
// Wartet bis die Domain auflösbar ist — verhindert "No valid IP" Fehler bei Certbot.
async function waitForDns(domain, maxWaitMs = 120_000) {
    const start = Date.now();
    const interval = 10_000;
    logger_js_1.logger.info(`[Step 5] Warte auf DNS-Propagation für ${domain}...`);
    while (Date.now() - start < maxWaitMs) {
        try {
            const result = await (0, safe_exec_js_1.safeExec)('dig', ['+short', domain], { timeout: 10_000, ignoreExitCode: true });
            const ip = result.stdout.trim();
            if (ip && ip.match(/^\d+\.\d+\.\d+\.\d+$/)) {
                logger_js_1.logger.info(`[Step 5] DNS für ${domain} aufgelöst: ${ip}`);
                return;
            }
        }
        catch {
            // dig nicht verfügbar? host versuchen
            try {
                const result = await (0, safe_exec_js_1.safeExec)('host', [domain], { timeout: 10_000, ignoreExitCode: true });
                if (result.stdout.includes('has address')) {
                    logger_js_1.logger.info(`[Step 5] DNS für ${domain} aufgelöst`);
                    return;
                }
            }
            catch { /* intentionally empty */ }
        }
        logger_js_1.logger.info(`[Step 5] DNS noch nicht propagiert — warte ${interval / 1000}s...`);
        await new Promise(resolve => setTimeout(resolve, interval));
    }
    // Nicht fatal werfen — Certbot gibt eine klarere Fehlermeldung
    logger_js_1.logger.warn(`[Step 5] DNS-Propagation für ${domain} unklar — versuche trotzdem Certbot`);
}
// ─── Step ─────────────────────────────────────────────────────────────────────
async function stepGetSsl(cfg) {
    const domains = [cfg.matrixDomain, cfg.webappDomain];
    // ── Idempotenz: beide Zertifikate vorhanden? ──────────────────────
    const allExist = domains.every(certExists);
    if (allExist) {
        logger_js_1.logger.info('[Step 5] SSL-Zertifikate bereits vorhanden — überspringe');
        return;
    }
    // ── DNS-Propagation abwarten ──────────────────────────────────────
    for (const domain of domains) {
        if (!certExists(domain)) {
            await waitForDns(domain);
        }
    }
    // ── Certbot für jede Domain ───────────────────────────────────────
    // Getrennte Aufrufe: falls eine Domain scheitert, bekommt die andere
    // trotzdem ihr Zertifikat. Fehler werden gesammelt und am Ende geworfen.
    const errors = [];
    for (const domain of domains) {
        if (certExists(domain)) {
            logger_js_1.logger.info(`[Step 5] Zertifikat für ${domain} bereits vorhanden — überspringe`);
            continue;
        }
        logger_js_1.logger.info(`[Step 5] Hole Zertifikat für ${domain}...`);
        try {
            const result = await (0, safe_exec_js_1.safeExec)('certbot', [
                'certonly',
                '--nginx',
                '--non-interactive',
                '--agree-tos',
                '--email', 'admin@prilog.chat',
                '--domain', domain,
                '--keep-until-expiring',
                '--quiet',
            ], { timeout: 120_000 });
            logger_js_1.logger.info(`[Step 5] Zertifikat für ${domain} erhalten`);
            if (result.stderr)
                logger_js_1.logger.info(`[Step 5] certbot stderr: ${result.stderr}`);
        }
        catch (err) {
            const msg = err?.message || String(err);
            logger_js_1.logger.error(`[Step 5] Certbot Fehler für ${domain}: ${msg}`);
            errors.push(`${domain}: ${msg}`);
        }
    }
    if (errors.length > 0) {
        throw new Error(`SSL-Fehler:\n${errors.join('\n')}`);
    }
    logger_js_1.logger.info('[Step 5] Alle SSL-Zertifikate erhalten');
}
async function verifyGetSsl(cfg) {
    const domains = [cfg.matrixDomain, cfg.webappDomain];
    for (const domain of domains) {
        if (!fs.existsSync(`/etc/letsencrypt/live/${domain}/fullchain.pem`) ||
            !fs.existsSync(`/etc/letsencrypt/live/${domain}/privkey.pem`)) {
            throw new Error(`SSL-Zertifikat für ${domain} fehlt nach Certbot`);
        }
    }
}
