import { config } from './config.js';
import { AgentTransport } from './transport/websocket.js';
import { collectMetrics } from './handlers/metrics.js';
import { getModuleStatus, enableModule, disableModule } from './handlers/modules.js';
import { executeCommand, spawnLogStream } from './utils/shell.js';
import { runHealthCheck, HealEvent } from './handlers/healer.js';
import { handleProvisionCommand } from './handlers/provision.js';
import { ensureMatrixConnectorInstalled } from './provision/connector.js';
import { ProvisionConfig } from './provision/types.js';
import { ServerCommandPayload, LogChunkPayload } from './types.js';
import { logger } from './utils/logger.js';

export class PrilogAgent {
  private transport: AgentTransport;
  private metricsTimer: NodeJS.Timeout | null = null;
  private healerTimer: NodeJS.Timeout | null = null;
  private logStreams = new Map<string, () => void>();

  // Verhindert parallele Provision-Läufe
  private provisionRunning = false;

  constructor() {
    this.transport = new AgentTransport();
    this.transport.onConnected    = () => this.onConnected();
    this.transport.onDisconnected = () => this.onDisconnected();
    this.transport.onCommand      = (cmd) => this.handleCommand(cmd);
  }

  // ─── Lifecycle ────────────────────────────────────────────────────────────────

  start() {
    logger.info(`🚀 Prilog Agent starting — subdomain: ${config.subdomain}`);
    this.transport.connect();

    process.on('SIGTERM', () => this.shutdown('SIGTERM'));
    process.on('SIGINT',  () => this.shutdown('SIGINT'));
  }

  private onConnected() {
    this.startMetricsLoop();
    this.startHealerLoop();
    this.sendModuleStatus();
  }

  private onDisconnected() {
    this.stopMetricsLoop();
    this.stopHealerLoop();
    this.stopAllLogStreams();
  }

  private shutdown(signal: string) {
    logger.info(`Shutdown signal: ${signal}`);
    this.stopMetricsLoop();
    this.stopHealerLoop();
    this.stopAllLogStreams();
    this.transport.shutdown();
    process.exit(0);
  }

  // ─── Metrics Loop ─────────────────────────────────────────────────────────────

  private startMetricsLoop() {
    this.stopMetricsLoop();
    this.pushMetrics();
    this.metricsTimer = setInterval(() => this.pushMetrics(), config.metricsInterval);
  }

  private stopMetricsLoop() {
    if (this.metricsTimer) {
      clearInterval(this.metricsTimer);
      this.metricsTimer = null;
    }
  }

  private async pushMetrics() {
    try {
      const metrics = await collectMetrics();
      this.transport.send('agent.metrics', metrics);
    } catch (err) {
      logger.error('Metrics collection failed', err);
    }
  }

  // ─── Healer Loop ──────────────────────────────────────────────────────────────

  private startHealerLoop() {
    this.stopHealerLoop();
    setTimeout(() => {
      this.runHealer();
      this.healerTimer = setInterval(() => this.runHealer(), config.healerInterval);
    }, 30_000);
  }

  private stopHealerLoop() {
    if (this.healerTimer) {
      clearInterval(this.healerTimer);
      this.healerTimer = null;
    }
  }

  private async runHealer() {
    // Während Provisioning läuft: Healer deaktivieren (verhindert Konflikte)
    if (this.provisionRunning) return;

    try {
      const events = await runHealthCheck();
      if (events.length > 0) {
        logger.info(`Healer: ${events.length} Event(s)`, events.map(e => e.type));
        this.transport.send('agent.heal_events', { events });
      }
    } catch (err) {
      logger.error('Healer failed', err);
    }
  }

  private sendModuleStatus() {
    try {
      const modules = getModuleStatus();
      this.transport.send('agent.module_status', { modules });
    } catch (err) {
      logger.error('Module status failed', err);
    }
  }

  // ─── Command Handler ──────────────────────────────────────────────────────────

  private async handleCommand(cmd: ServerCommandPayload) {
    const { commandId, command, args } = cmd;
    const start = Date.now();

    logger.info(`Executing command: ${command}`, args);

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
        handleProvisionCommand(
          commandId,
          args as Record<string, unknown> ?? {},
          (type, payload) => this.transport.send(type as any, payload)
        ).finally(() => {
          this.provisionRunning = false;
        });

        return;
      }

      // ── Log Streaming ──────────────────────────────────────────────────────
      if (command === 'logs.stream.start') {
        const source = (args?.source as 'synapse' | 'nginx' | 'agent') ?? 'synapse';
        const streamId = args?.streamId as string ?? commandId;

        this.stopLogStream(streamId);

        const stopFn = spawnLogStream(
          source,
          (line) => {
            const payload: LogChunkPayload = { source, streamId, lines: [line] };
            this.transport.send('agent.log_chunk', payload);
          },
          () => {
            logger.info(`Log stream ended: ${streamId}`);
            this.logStreams.delete(streamId);
          }
        );

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
        const streamId = args?.streamId as string ?? commandId;
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
        const result = await enableModule(args?.module as string);
        this.sendModuleStatus();
        this.transport.send('agent.command_result', { commandId, ...result, duration: Date.now() - start });
        return;
      }

      if (command === 'module.disable') {
        const result = await disableModule(args?.module as string);
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
        const connectorConfig = args?.config as ProvisionConfig | undefined;

        if (!connectorConfig) {
          this.transport.send('agent.command_result', {
            commandId,
            success: false,
            output: 'connector.install benötigt args.config',
            duration: Date.now() - start,
          });
          return;
        }

        const result = await ensureMatrixConnectorInstalled(connectorConfig, {
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
      const result = await executeCommand(command, args as Record<string, string | number | boolean> | undefined);
      this.transport.send('agent.command_result', { commandId, ...result });

    } catch (err: any) {
      logger.error(`Command failed: ${command}`, err);
      this.transport.send('agent.command_result', {
        commandId,
        success: false,
        output: err?.message ?? 'Internal error',
        duration: Date.now() - start,
      });
    }
  }

  // ─── Log Stream Management ────────────────────────────────────────────────────

  private stopLogStream(streamId: string) {
    const stop = this.logStreams.get(streamId);
    if (stop) {
      stop();
      this.logStreams.delete(streamId);
      logger.debug(`Stopped log stream: ${streamId}`);
    }
  }

  private stopAllLogStreams() {
    this.logStreams.forEach((stop, id) => {
      stop();
      logger.debug(`Stopped log stream on disconnect: ${id}`);
    });
    this.logStreams.clear();
  }
}
