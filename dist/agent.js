"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.PrilogAgent = void 0;
const config_js_1 = require("./config.js");
const websocket_js_1 = require("./transport/websocket.js");
const metrics_js_1 = require("./handlers/metrics.js");
const modules_js_1 = require("./handlers/modules.js");
const shell_js_1 = require("./utils/shell.js");
const healer_js_1 = require("./handlers/healer.js");
const provision_js_1 = require("./handlers/provision.js");
const provision_shared_js_1 = require("./handlers/provision-shared.js");
const connector_js_1 = require("./provision/connector.js");
const logger_js_1 = require("./utils/logger.js");
class PrilogAgent {
    transport;
    metricsTimer = null;
    healerTimer = null;
    logStreams = new Map();
    // Verhindert parallele Provision-Läufe
    provisionRunning = false;
    constructor() {
        this.transport = new websocket_js_1.AgentTransport();
        this.transport.onConnected = () => this.onConnected();
        this.transport.onDisconnected = () => this.onDisconnected();
        this.transport.onCommand = (cmd) => this.handleCommand(cmd);
    }
    // ─── Lifecycle ────────────────────────────────────────────────────────────────
    start() {
        logger_js_1.logger.info(`🚀 Prilog Agent starting — subdomain: ${config_js_1.config.subdomain}`);
        this.transport.connect();
        process.on('SIGTERM', () => this.shutdown('SIGTERM'));
        process.on('SIGINT', () => this.shutdown('SIGINT'));
    }
    onConnected() {
        this.startMetricsLoop();
        this.startHealerLoop();
        this.sendModuleStatus();
    }
    onDisconnected() {
        this.stopMetricsLoop();
        this.stopHealerLoop();
        this.stopAllLogStreams();
    }
    shutdown(signal) {
        logger_js_1.logger.info(`Shutdown signal: ${signal}`);
        this.stopMetricsLoop();
        this.stopHealerLoop();
        this.stopAllLogStreams();
        this.transport.shutdown();
        process.exit(0);
    }
    // ─── Metrics Loop ─────────────────────────────────────────────────────────────
    startMetricsLoop() {
        this.stopMetricsLoop();
        this.pushMetrics();
        this.metricsTimer = setInterval(() => this.pushMetrics(), config_js_1.config.metricsInterval);
    }
    stopMetricsLoop() {
        if (this.metricsTimer) {
            clearInterval(this.metricsTimer);
            this.metricsTimer = null;
        }
    }
    async pushMetrics() {
        try {
            const metrics = await (0, metrics_js_1.collectMetrics)();
            this.transport.send('agent.metrics', metrics);
        }
        catch (err) {
            logger_js_1.logger.error('Metrics collection failed', err);
        }
    }
    // ─── Healer Loop ──────────────────────────────────────────────────────────────
    startHealerLoop() {
        this.stopHealerLoop();
        setTimeout(() => {
            this.runHealer();
            this.healerTimer = setInterval(() => this.runHealer(), config_js_1.config.healerInterval);
        }, 30_000);
    }
    stopHealerLoop() {
        if (this.healerTimer) {
            clearInterval(this.healerTimer);
            this.healerTimer = null;
        }
    }
    async runHealer() {
        // Während Provisioning läuft: Healer deaktivieren (verhindert Konflikte)
        if (this.provisionRunning)
            return;
        try {
            const events = await (0, healer_js_1.runHealthCheck)();
            if (events.length > 0) {
                logger_js_1.logger.info(`Healer: ${events.length} Event(s)`, events.map(e => e.type));
                this.transport.send('agent.heal_events', { events });
            }
        }
        catch (err) {
            logger_js_1.logger.error('Healer failed', err);
        }
    }
    sendModuleStatus() {
        try {
            const modules = (0, modules_js_1.getModuleStatus)();
            this.transport.send('agent.module_status', { modules });
        }
        catch (err) {
            logger_js_1.logger.error('Module status failed', err);
        }
    }
    // ─── Command Handler ──────────────────────────────────────────────────────────
    async handleCommand(cmd) {
        const { commandId, command, args } = cmd;
        const start = Date.now();
        logger_js_1.logger.info(`Executing command: ${command}`, args);
        try {
            // ── Provisioning ───────────────────────────────────────────────────────
            if (command === 'provision') {
                if (this.provisionRunning) {
                    this.transport.send('agent.command_result', {
                        commandId,
                        success: false,
                        output: 'Provisioning läuft bereits — bitte warten',
                        duration: Date.now() - start,
                    });
                    return;
                }
                this.provisionRunning = true;
                // Async starten — nicht awaiten damit WebSocket nicht blockiert wird
                (0, provision_js_1.handleProvisionCommand)(commandId, args ?? {}, (type, payload) => this.transport.send(type, payload)).finally(() => {
                    this.provisionRunning = false;
                });
                return;
            }
            // ── Shared-Tenant Provisioning ──────────────────────────────────────────
            if (command === 'shared_tenant.create') {
                if (this.provisionRunning) {
                    this.transport.send('agent.command_result', {
                        commandId,
                        success: false,
                        output: 'Provisioning läuft bereits — bitte warten',
                        duration: Date.now() - start,
                    });
                    return;
                }
                this.provisionRunning = true;
                (0, provision_shared_js_1.handleSharedTenantCreate)(commandId, args ?? {}, (type, payload) => this.transport.send(type, payload)).finally(() => {
                    this.provisionRunning = false;
                });
                return;
            }
            // ── Log Streaming ──────────────────────────────────────────────────────
            if (command === 'logs.stream.start') {
                const source = args?.source ?? 'synapse';
                const streamId = args?.streamId ?? commandId;
                this.stopLogStream(streamId);
                const stopFn = (0, shell_js_1.spawnLogStream)(source, (line) => {
                    const payload = { source, streamId, lines: [line] };
                    this.transport.send('agent.log_chunk', payload);
                }, () => {
                    logger_js_1.logger.info(`Log stream ended: ${streamId}`);
                    this.logStreams.delete(streamId);
                });
                this.logStreams.set(streamId, stopFn);
                this.transport.send('agent.command_result', {
                    commandId,
                    success: true,
                    output: `Log stream started: ${source}`,
                    duration: Date.now() - start,
                });
                return;
            }
            if (command === 'logs.stream.stop') {
                const streamId = args?.streamId ?? commandId;
                this.stopLogStream(streamId);
                this.transport.send('agent.command_result', {
                    commandId,
                    success: true,
                    output: `Log stream stopped: ${streamId}`,
                    duration: Date.now() - start,
                });
                return;
            }
            // ── Module Commands ────────────────────────────────────────────────────
            if (command === 'module.enable') {
                const result = await (0, modules_js_1.enableModule)(args?.module);
                this.sendModuleStatus();
                this.transport.send('agent.command_result', { commandId, ...result, duration: Date.now() - start });
                return;
            }
            if (command === 'module.disable') {
                const result = await (0, modules_js_1.disableModule)(args?.module);
                this.sendModuleStatus();
                this.transport.send('agent.command_result', { commandId, ...result, duration: Date.now() - start });
                return;
            }
            if (command === 'module.status') {
                this.sendModuleStatus();
                this.transport.send('agent.command_result', {
                    commandId, success: true, output: 'Module status sent', duration: Date.now() - start,
                });
                return;
            }
            if (command === 'connector.install') {
                const connectorConfig = args?.config;
                if (!connectorConfig) {
                    this.transport.send('agent.command_result', {
                        commandId,
                        success: false,
                        output: 'connector.install benötigt args.config',
                        duration: Date.now() - start,
                    });
                    return;
                }
                const result = await (0, connector_js_1.ensureMatrixConnectorInstalled)(connectorConfig, {
                    refreshCompose: true,
                    restartSynapse: true,
                });
                this.transport.send('agent.command_result', {
                    commandId,
                    success: true,
                    output: result.message,
                    duration: Date.now() - start,
                });
                return;
            }
            // ── Shell Commands (Whitelist) ─────────────────────────────────────────
            const result = await (0, shell_js_1.executeCommand)(command, args);
            this.transport.send('agent.command_result', { commandId, ...result });
        }
        catch (err) {
            logger_js_1.logger.error(`Command failed: ${command}`, err);
            this.transport.send('agent.command_result', {
                commandId,
                success: false,
                output: err?.message ?? 'Internal error',
                duration: Date.now() - start,
            });
        }
    }
    // ─── Log Stream Management ────────────────────────────────────────────────────
    stopLogStream(streamId) {
        const stop = this.logStreams.get(streamId);
        if (stop) {
            stop();
            this.logStreams.delete(streamId);
            logger_js_1.logger.debug(`Stopped log stream: ${streamId}`);
        }
    }
    stopAllLogStreams() {
        this.logStreams.forEach((stop, id) => {
            stop();
            logger_js_1.logger.debug(`Stopped log stream on disconnect: ${id}`);
        });
        this.logStreams.clear();
    }
}
exports.PrilogAgent = PrilogAgent;
