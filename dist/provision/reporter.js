"use strict";
/**
 * provision/reporter.ts
 *
 * Sendet Step-Status ans Backend via WebSocket.
 * Das Backend speichert den Status in der DB und streamt ihn ans Admin-Frontend.
 *
 * Protokoll (Agent → Backend):
 *   type: "agent.provision_step"
 *   payload: { orderId, step, status, message? }
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.createReporter = createReporter;
const logger_js_1 = require("../utils/logger.js");
// ─── Factory ──────────────────────────────────────────────────────────────────
/**
 * Erstellt eine ReportFn die über den übergebenen send-Kanal
 * Step-Status ans Backend meldet.
 */
function createReporter(send, orderId) {
    return (step, status, message) => {
        const payload = { orderId, step, status, message };
        logger_js_1.logger.info(`[Provision] ${step} → ${status}${message ? ': ' + message : ''}`);
        const sent = send('agent.provision_step', payload);
        if (!sent) {
            // WebSocket kurzzeitig nicht verfügbar — nicht kritisch, weitermachen.
            // Backend erkennt fehlende Steps beim Reconnect.
            logger_js_1.logger.warn(`[Provision] Reporter: Konnte Step-Status nicht senden (${step}/${status})`);
        }
    };
}
