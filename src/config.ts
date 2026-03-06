import 'dotenv/config';

function required(key: string): string {
  const val = process.env[key];
  if (!val) throw new Error(`Missing required env var: ${key}`);
  return val;
}

export const config = {
  // Identity
  agentToken:      required('AGENT_TOKEN'),
  subdomain:       required('SUBDOMAIN'),

  // Backend connection
  backendWsUrl:    process.env.BACKEND_WS_URL    || 'wss://api.prilog.chat/agent/ws',
  backendApiUrl:   process.env.BACKEND_API_URL   || 'https://api.prilog.chat',

  // Local Synapse
  synapseAdminUrl: process.env.SYNAPSE_ADMIN_URL || 'http://localhost:8008',
  matrixDomain:    required('MATRIX_DOMAIN'),

  // Intervals (ms)
  metricsInterval: parseInt(process.env.METRICS_INTERVAL || '30000'),
  heartbeatInterval: parseInt(process.env.HEARTBEAT_INTERVAL || '15000'),

  // Reconnect
  reconnectBaseMs: 2000,
  reconnectMaxMs:  60000,
};
