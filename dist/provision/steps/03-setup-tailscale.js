"use strict";
/**
 * provision/steps/03-setup-tailscale.ts
 *
 * Tailscale installieren und mit dem Prilog Tailnet verbinden.
 * Idempotent: prüft ob Tailscale bereits verbunden ist.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.stepSetupTailscale = stepSetupTailscale;
exports.verifySetupTailscale = verifySetupTailscale;
const logger_js_1 = require("../../utils/logger.js");
const safe_exec_js_1 = require("../engine/safe-exec.js");
async function isTailscaleConnected() {
    const result = await (0, safe_exec_js_1.safeExec)('tailscale', ['status'], { ignoreExitCode: true });
    return result.exitCode === 0 && result.stdout.includes('prilog-');
}
async function isTailscaleInstalled() {
    const result = await (0, safe_exec_js_1.safeExec)('which', ['tailscale'], { ignoreExitCode: true });
    return result.exitCode === 0;
}
async function stepSetupTailscale(cfg) {
    if (await isTailscaleConnected()) {
        logger_js_1.logger.info('[Step 03] Tailscale bereits verbunden — überspringe');
        return;
    }
    if (!(await isTailscaleInstalled())) {
        logger_js_1.logger.info('[Step 03] Installiere Tailscale...');
        // Shell pipe — hardcoded install script, no user input
        await (0, safe_exec_js_1.safeExec)('bash', ['-c', 'curl -fsSL https://tailscale.com/install.sh | sh'], {
            timeout: 120_000,
        });
    }
    logger_js_1.logger.info(`[Step 03] Verbinde mit Tailnet als prilog-${cfg.subdomain}...`);
    await (0, safe_exec_js_1.safeExec)('tailscale', ['up', `--authkey=${cfg.tailscaleAuthKey}`, `--hostname=prilog-${cfg.subdomain}`, '--accept-routes'], { timeout: 60_000 });
    logger_js_1.logger.info('[Step 03] Tailscale verbunden');
}
async function verifySetupTailscale(_cfg) {
    if (!(await isTailscaleConnected())) {
        throw new Error('Tailscale nicht verbunden nach Setup (tailscale status zeigt nicht "Connected")');
    }
}
