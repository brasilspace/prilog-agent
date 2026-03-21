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
  | 'agent.provision_step'    // Step-Status während Provisioning

  // Backend → Agent
  | 'server.command'
  | 'server.ack';

export interface AgentMessage {
  type: MessageType;
  id:   string;
  ts:   number;
  payload: unknown;
}

// ─── Payloads Agent → Backend ─────────────────────────────────────────────────

export interface HelloPayload {
  subdomain:    string;
  agentVersion: string;
  hostname:     string;
  uptime:       number;
}

export interface MetricsPayload {
  cpu:          number;
  ram:          number;
  ramTotal:     number;
  ramUsed:      number;
  disk:         number;
  diskTotal:    number;
  diskUsed:     number;
  volumeUsage:  number;
  matrixUsers:  number;
  synapseUp:    boolean;
  loadAvg:      [number, number, number];
  uptimeSeconds: number;
}

export interface LogChunkPayload {
  source:   string;
  lines:    string[];
  streamId: string;
}

export interface CommandResultPayload {
  commandId: string;
  success:   boolean;
  output?:   string;
  error?:    string;
  duration:  number;
}

export interface ModuleStatusPayload {
  modules: ModuleInfo[];
}

export interface ModuleInfo {
  name:     string;
  enabled:  boolean;
  running:  boolean;
  version?: string;
  error?:   string;
}

// ─── Provision Step Payload (Agent → Backend) ─────────────────────────────────

export interface ProvisionStepPayload {
  orderId:  string;
  step:     string;
  status:   'running' | 'success' | 'error';
  message?: string;
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
  | 'agent.version'
  | 'provision'
  | 'connector.install';

export interface ServerCommandPayload {
  commandId: string;
  command:   CommandName;
  args?:     Record<string, unknown>;
}
