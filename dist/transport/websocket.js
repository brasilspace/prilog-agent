"use strict";
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
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.AgentTransport = void 0;
exports.buildMessage = buildMessage;
const ws_1 = __importDefault(require("ws"));
const os = __importStar(require("os"));
const config_js_1 = require("../config.js");
const logger_js_1 = require("../utils/logger.js");
const AGENT_VERSION = '1.0.0';
// ─── Message Factory ──────────────────────────────────────────────────────────
let msgCounter = 0;
function makeId() {
    return `${Date.now()}-${++msgCounter}`;
}
function buildMessage(type, payload) {
    return { type, id: makeId(), ts: Date.now(), payload };
}
// ─── WebSocket Transport ──────────────────────────────────────────────────────
class AgentTransport {
    ws = null;
    reconnectAttempts = 0;
    reconnectTimer = null;
    heartbeatTimer = null;
    isShuttingDown = false;
    // Callbacks
    onCommand;
    onConnected;
    onDisconnected;
    connect() {
        if (this.isShuttingDown)
            return;
        const url = `${config_js_1.config.backendWsUrl}?token=${config_js_1.config.agentToken}`;
        logger_js_1.logger.info(`Connecting to ${config_js_1.config.backendWsUrl}...`);
        this.ws = new ws_1.default(url, {
            handshakeTimeout: 10_000,
        });
        this.ws.on('open', () => {
            logger_js_1.logger.info('✅ Connected to Prilog backend');
            this.reconnectAttempts = 0;
            // Hello senden
            this.send('agent.hello', {
                subdomain: config_js_1.config.subdomain,
                agentVersion: AGENT_VERSION,
                hostname: os.hostname(),
                uptime: os.uptime(),
            });
            this.startHeartbeat();
            this.onConnected?.();
        });
        this.ws.on('message', (raw) => {
            try {
                const msg = JSON.parse(raw.toString());
                this.handleIncoming(msg);
            }
            catch (err) {
                logger_js_1.logger.warn('Invalid message received', err);
            }
        });
        this.ws.on('close', (code, reason) => {
            logger_js_1.logger.warn(`Disconnected (${code}: ${reason.toString() || 'no reason'})`);
            this.stopHeartbeat();
            this.ws = null;
            this.onDisconnected?.();
            this.scheduleReconnect();
        });
        this.ws.on('error', (err) => {
            logger_js_1.logger.error('WebSocket error', err.message);
            // close event wird danach gefeuert
        });
    }
    handleIncoming(msg) {
        switch (msg.type) {
            case 'server.ack':
                logger_js_1.logger.debug(`ACK received for ${msg.payload?.id}`);
                break;
            case 'server.command':
                logger_js_1.logger.info(`Command received: ${msg.payload.command}`);
                this.onCommand?.(msg.payload);
                break;
            default:
                logger_js_1.logger.warn(`Unknown message type: ${msg.type}`);
        }
    }
    send(type, payload) {
        if (!this.ws || this.ws.readyState !== ws_1.default.OPEN) {
            logger_js_1.logger.debug(`Cannot send ${type} — not connected`);
            return false;
        }
        try {
            this.ws.send(JSON.stringify(buildMessage(type, payload)));
            return true;
        }
        catch (err) {
            logger_js_1.logger.error('Send failed', err);
            return false;
        }
    }
    isConnected() {
        return this.ws?.readyState === ws_1.default.OPEN;
    }
    // ─── Heartbeat ───────────────────────────────────────────────────────────────
    startHeartbeat() {
        this.stopHeartbeat();
        this.heartbeatTimer = setInterval(() => {
            this.send('agent.heartbeat', { ts: Date.now(), uptime: os.uptime() });
        }, config_js_1.config.heartbeatInterval);
    }
    stopHeartbeat() {
        if (this.heartbeatTimer) {
            clearInterval(this.heartbeatTimer);
            this.heartbeatTimer = null;
        }
    }
    // ─── Reconnect with exponential backoff ──────────────────────────────────────
    scheduleReconnect() {
        if (this.isShuttingDown)
            return;
        const delay = Math.min(config_js_1.config.reconnectBaseMs * Math.pow(2, this.reconnectAttempts), config_js_1.config.reconnectMaxMs);
        this.reconnectAttempts++;
        logger_js_1.logger.info(`Reconnecting in ${delay / 1000}s (attempt ${this.reconnectAttempts})...`);
        this.reconnectTimer = setTimeout(() => this.connect(), delay);
    }
    shutdown() {
        this.isShuttingDown = true;
        this.stopHeartbeat();
        if (this.reconnectTimer)
            clearTimeout(this.reconnectTimer);
        if (this.ws) {
            this.ws.close(1000, 'Agent shutdown');
            this.ws = null;
        }
        logger_js_1.logger.info('Agent transport shut down');
    }
}
exports.AgentTransport = AgentTransport;
