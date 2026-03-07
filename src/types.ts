// ─── Message Protocol ─────────────────────────────────────────────────────────
// Alle Nachrichten zwischen Agent und Backend haben dieses Format.

export type MessageType =
  // Agent → Backend
  | 'agent.hello'
  | 'agent.heartbeat'
  | 'agent.metrics'
  | 'agent.log_chunk'
  | 'agent.command_result'
  | 'agent.module_status'
  | 'agent.heal_events'

  // Backend → Agent
  | 'server.command'
  | 'server.ack';

export interface AgentMessage {
  type: MessageType;
  id:   string;   // nanoid — für Command-Korrelation
  ts:   number;   // Unix timestamp ms
  payload: unknown;
}

// ─── Payloads Agent → Backend ─────────────────────────────────────────────────

export interface HelloPayload {
  subdomain:   string;
  agentVersion: string;
  hostname:    string;
  uptime:      number;
}

export interface MetricsPayload {
  cpu:         number;   // %
  ram:         number;   // % used
  ramTotal:    number;   // MB
  ramUsed:     number;   // MB
  disk:        number;   // % used
  diskTotal:   number;   // GB
  diskUsed:    number;   // GB
  volumeUsage: number;   // % (Synapse data volume)
  matrixUsers: number;   // Synapse user count
  synapseUp:   boolean;
  loadAvg:     [number, number, number];
  uptimeSeconds: number;
}

export interface LogChunkPayload {
  source:  string;   // 'synapse' | 'nginx' | 'agent'
  lines:   string[];
  streamId: string;  // Korreliert mit stream request
}

export interface CommandResultPayload {
  commandId: string;
  success:   boolean;
  output?:   string;
  error?:    string;
  duration:  number; // ms
}

export interface ModuleStatusPayload {
  modules: ModuleInfo[];
}

export interface ModuleInfo {
  name:      string;
  enabled:   boolean;
  running:   boolean;
  version?:  string;
  error?:    string;
}

// ─── Payloads Backend → Agent ─────────────────────────────────────────────────

export type CommandName =
  | 'synapse.restart'
  | 'synapse.reload'
  | 'synapse.status'
  | 'docker.ps'
  | 'docker.logs'
  | 'module.enable'
  | 'module.disable'
  | 'module.status'
  | 'logs.stream.start'
  | 'logs.stream.stop'
  | 'system.status'
  | 'system.df'
  | 'agent.update'
  | 'agent.version';

export interface ServerCommandPayload {
  commandId: string;
  command:   CommandName;
  args?:     Record<string, string | number | boolean>;
}
