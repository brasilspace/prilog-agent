import WebSocket from 'ws';
import * as os from 'os';
import { config } from '../config.js';
import { AgentMessage, MessageType, ServerCommandPayload } from '../types.js';
import { logger } from '../utils/logger.js';

const AGENT_VERSION = '1.0.0';

// ─── Message Factory ──────────────────────────────────────────────────────────

let msgCounter = 0;
function makeId(): string {
  return `${Date.now()}-${++msgCounter}`;
}

export function buildMessage(type: MessageType, payload: unknown): AgentMessage {
  return { type, id: makeId(), ts: Date.now(), payload };
}

// ─── WebSocket Transport ──────────────────────────────────────────────────────

export class AgentTransport {
  private ws: WebSocket | null = null;
  private reconnectAttempts = 0;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private heartbeatTimer: NodeJS.Timeout | null = null;
  private isShuttingDown = false;

  // Callbacks
  onCommand?: (payload: ServerCommandPayload) => void;
  onConnected?: () => void;
  onDisconnected?: () => void;

  connect() {
    if (this.isShuttingDown) return;

    const url = `${config.backendWsUrl}?token=${config.agentToken}`;
    logger.info(`Connecting to ${config.backendWsUrl}...`);

    this.ws = new WebSocket(url, {
      handshakeTimeout: 10_000,
    });

    this.ws.on('open', () => {
      logger.info('✅ Connected to Prilog backend');
      this.reconnectAttempts = 0;

      // Hello senden
      this.send('agent.hello', {
        subdomain:    config.subdomain,
        agentVersion: AGENT_VERSION,
        hostname:     os.hostname(),
        uptime:       os.uptime(),
      });

      this.startHeartbeat();
      this.onConnected?.();
    });

    this.ws.on('message', (raw) => {
      try {
        const msg = JSON.parse(raw.toString()) as AgentMessage;
        this.handleIncoming(msg);
      } catch (err) {
        logger.warn('Invalid message received', err);
      }
    });

    this.ws.on('close', (code, reason) => {
      logger.warn(`Disconnected (${code}: ${reason.toString() || 'no reason'})`);
      this.stopHeartbeat();
      this.ws = null;
      this.onDisconnected?.();
      this.scheduleReconnect();
    });

    this.ws.on('error', (err) => {
      logger.error('WebSocket error', err.message);
      // close event wird danach gefeuert
    });
  }

  private handleIncoming(msg: AgentMessage) {
    switch (msg.type) {
      case 'server.ack':
        logger.debug(`ACK received for ${(msg.payload as any)?.id}`);
        break;

      case 'server.command':
        logger.info(`Command received: ${(msg.payload as ServerCommandPayload).command}`);
        this.onCommand?.(msg.payload as ServerCommandPayload);
        break;

      default:
        logger.warn(`Unknown message type: ${msg.type}`);
    }
  }

  send(type: MessageType, payload: unknown): boolean {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      logger.debug(`Cannot send ${type} — not connected`);
      return false;
    }

    try {
      this.ws.send(JSON.stringify(buildMessage(type, payload)));
      return true;
    } catch (err) {
      logger.error('Send failed', err);
      return false;
    }
  }

  isConnected(): boolean {
    return this.ws?.readyState === WebSocket.OPEN;
  }

  // ─── Heartbeat ───────────────────────────────────────────────────────────────

  private startHeartbeat() {
    this.stopHeartbeat();
    this.heartbeatTimer = setInterval(() => {
      this.send('agent.heartbeat', { ts: Date.now(), uptime: os.uptime() });
    }, config.heartbeatInterval);
  }

  private stopHeartbeat() {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
  }

  // ─── Reconnect with exponential backoff ──────────────────────────────────────

  private scheduleReconnect() {
    if (this.isShuttingDown) return;

    const delay = Math.min(
      config.reconnectBaseMs * Math.pow(2, this.reconnectAttempts),
      config.reconnectMaxMs
    );
    this.reconnectAttempts++;

    logger.info(`Reconnecting in ${delay / 1000}s (attempt ${this.reconnectAttempts})...`);
    this.reconnectTimer = setTimeout(() => this.connect(), delay);
  }

  shutdown() {
    this.isShuttingDown = true;
    this.stopHeartbeat();
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    if (this.ws) {
      this.ws.close(1000, 'Agent shutdown');
      this.ws = null;
    }
    logger.info('Agent transport shut down');
  }
}
