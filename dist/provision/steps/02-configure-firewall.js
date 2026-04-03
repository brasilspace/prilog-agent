"use strict";
/**
 * provision/steps/02-configure-firewall.ts
 *
 * UFW Firewall konfigurieren.
 * Idempotent: ufw-Regeln können mehrfach gesetzt werden.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.stepConfigureFirewall = stepConfigureFirewall;
exports.verifyConfigureFirewall = verifyConfigureFirewall;
const logger_js_1 = require("../../utils/logger.js");
const safe_exec_js_1 = require("../engine/safe-exec.js");
async function isUfwEnabled() {
    const result = await (0, safe_exec_js_1.safeExec)('ufw', ['status'], { ignoreExitCode: true });
    return result.exitCode === 0 && result.stdout.includes('Status: active');
}
async function stepConfigureFirewall(_cfg) {
    logger_js_1.logger.info('[Step 02] Konfiguriere UFW Firewall...');
    // fail2ban installieren
    await (0, safe_exec_js_1.safeExec)('apt-get', ['install', '-y', 'ufw', 'fail2ban'], { timeout: 60_000 });
    if (await isUfwEnabled()) {
        logger_js_1.logger.info('[Step 02] UFW bereits aktiv — überspringe');
        return;
    }
    await (0, safe_exec_js_1.safeExec)('ufw', ['default', 'deny', 'incoming'], { timeout: 10_000 });
    await (0, safe_exec_js_1.safeExec)('ufw', ['default', 'allow', 'outgoing'], { timeout: 10_000 });
    await (0, safe_exec_js_1.safeExec)('ufw', ['allow', '22/tcp'], { timeout: 10_000 });
    await (0, safe_exec_js_1.safeExec)('ufw', ['allow', '80/tcp'], { timeout: 10_000 });
    await (0, safe_exec_js_1.safeExec)('ufw', ['allow', '443/tcp'], { timeout: 10_000 });
    await (0, safe_exec_js_1.safeExec)('ufw', ['allow', '8448/tcp'], { timeout: 10_000 });
    await (0, safe_exec_js_1.safeExec)('ufw', ['allow', 'in', 'on', 'tailscale0'], { timeout: 10_000 });
    await (0, safe_exec_js_1.safeExec)('ufw', ['--force', 'enable'], { timeout: 15_000 });
    logger_js_1.logger.info('[Step 02] Firewall konfiguriert und aktiviert');
}
async function verifyConfigureFirewall(_cfg) {
    const result = await (0, safe_exec_js_1.safeExec)('ufw', ['status'], { ignoreExitCode: true, timeout: 5_000 });
    if (result.exitCode !== 0 || !result.stdout.includes('Status: active')) {
        throw new Error(`Firewall-Prüfung fehlgeschlagen: UFW nicht aktiv`);
    }
}
