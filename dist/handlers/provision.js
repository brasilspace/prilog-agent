"use strict";
/**
 * handlers/provision.ts
 *
 * Empfängt den "provision"-Befehl vom Backend und startet den Step-Runner.
 *
 * Wird von agent.ts aufgerufen wenn:
 *   msg.type === 'server.command' && cmd.command === 'provision'
 *
 * Das Backend sendet:
 *   { command: "provision", args: { config: {...}, startFromStep?: "..." } }
 *
 * Der Handler:
 *   1. Liest ProvisionConfig aus den args
 *   2. Validiert mit Zod-Schema
 *   3. Erstellt einen Reporter (meldet Steps via WebSocket)
 *   4. Startet den Runner
 *   5. Gibt Ergebnis via agent.command_result zurück
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.handleProvisionCommand = handleProvisionCommand;
const reporter_js_1 = require("../provision/reporter.js");
const runner_js_1 = require("../provision/runner.js");
const config_validator_js_1 = require("../provision/engine/config-validator.js");
const logger_js_1 = require("../utils/logger.js");
// ─── Handler ──────────────────────────────────────────────────────────────────
async function handleProvisionCommand(commandId, args, send) {
    const start = Date.now();
    // ── Config validieren ─────────────────────────────────────────────
    const rawConfig = args?.config;
    if (!rawConfig) {
        logger_js_1.logger.error('[ProvisionHandler] Kein config-Objekt in den args');
        send('agent.command_result', {
            commandId,
            success: false,
            output: 'Provision-Befehl ohne config — Programmfehler im Backend',
            duration: Date.now() - start,
        });
        return;
    }
    // Zod-basierte Validierung
    let config;
    try {
        config = (0, config_validator_js_1.validateProvisionConfig)(rawConfig);
    }
    catch (err) {
        const message = err?.issues
            ? err.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join(', ')
            : (err?.message ?? String(err));
        logger_js_1.logger.error(`[ProvisionHandler] Config-Validierung fehlgeschlagen: ${message}`);
        send('agent.command_result', {
            commandId,
            success: false,
            output: `Config-Validierung fehlgeschlagen: ${message}`,
            duration: Date.now() - start,
        });
        return;
    }
    const startFromStep = args?.startFromStep;
    logger_js_1.logger.info(`[ProvisionHandler] Starte Provisioning für ${config.subdomain}` +
        (startFromStep ? ` ab Step: ${startFromStep}` : ''));
    // ── Reporter erstellen ────────────────────────────────────────────
    const report = (0, reporter_js_1.createReporter)(send, config.orderId);
    // ── Runner starten ────────────────────────────────────────────────
    try {
        const results = await (0, runner_js_1.runProvision)(config, report, startFromStep);
        const allSuccess = results.every(r => r.status !== 'error');
        const failedStep = results.find(r => r.status === 'error');
        send('agent.command_result', {
            commandId,
            success: allSuccess,
            output: allSuccess
                ? `Provisioning abgeschlossen (${results.filter(r => r.status === 'success').length} Steps)`
                : `Provisioning gestoppt bei Step: ${failedStep?.step} — ${failedStep?.message}`,
            duration: Date.now() - start,
        });
    }
    catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        logger_js_1.logger.error(`[ProvisionHandler] Runner-Fehler: ${message}`);
        send('agent.command_result', {
            commandId,
            success: false,
            output: `Provision-Runner Fehler: ${message}`,
            duration: Date.now() - start,
        });
    }
}
