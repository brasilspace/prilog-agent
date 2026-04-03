"use strict";
/**
 * provision/steps/08-finalize.ts
 *
 * Step 8: Finalisierung — Backend über abgeschlossenes Provisioning informieren.
 *
 * Sendet POST /api/agent/ready → Backend setzt installationStatus = 'complete',
 * speichert den synapseAdminToken und verschickt die "Server bereit" E-Mail.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.stepFinalize = stepFinalize;
exports.verifyFinalize = verifyFinalize;
const logger_js_1 = require("../../utils/logger.js");
const safe_exec_js_1 = require("../engine/safe-exec.js");
async function stepFinalize(cfg) {
    logger_js_1.logger.info('[Step 8] Sende Ready-Callback ans Backend...');
    const url = `${cfg.backendApiUrl}/api/agent/ready`;
    const body = JSON.stringify({
        status: 'ready',
        orderId: cfg.orderId,
        synapseAdminToken: cfg.synapseAdminToken ?? null,
    });
    try {
        const result = await (0, safe_exec_js_1.safeExec)('curl', [
            '-sf', '-X', 'POST',
            url,
            '-H', `Authorization: Bearer ${cfg.agentToken}`,
            '-H', 'Content-Type: application/json',
            '-d', body,
            '--max-time', '30',
            '--retry', '3',
            '--retry-delay', '5',
        ], { timeout: 60_000 });
        logger_js_1.logger.info(`[Step 8] Backend Antwort: ${result.stdout.trim()}`);
        logger_js_1.logger.info('[Step 8] Provisioning abgeschlossen — Server ist bereit!');
    }
    catch (err) {
        const msg = err?.message || String(err);
        logger_js_1.logger.warn(`[Step 8] Ready-Callback fehlgeschlagen (nicht fatal): ${msg}`);
        throw new Error(`Ready-Callback fehlgeschlagen: ${msg}`);
    }
}
async function verifyFinalize(_cfg) {
    // Kein weiterer Check nötig
}
