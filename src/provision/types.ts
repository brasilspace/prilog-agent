/**
 * provision/types.ts
 *
 * Typdefinitionen für das Agent-based Provisioning System.
 * Der Agent empfängt einen ProvisionCommand vom Backend und führt
 * die Steps sequenziell aus — mit Status-Reporting nach jedem Step.
 */

// ─── Step Names ───────────────────────────────────────────────────────────────

export const STEP_NAMES = [
  'install_nginx',
  'generate_synapse',
  'write_compose',
  'start_containers',
  'get_ssl',
  'configure_nginx_ssl',
  'create_admin_user',
  'finalize',
] as const;

export type StepName = typeof STEP_NAMES[number];

export type StepStatus = 'pending' | 'running' | 'success' | 'error' | 'skipped';

// ─── Provision Config (vom Backend gesendet) ──────────────────────────────────

export interface ProvisionConfig {
  orderId:            string;
  subdomain:          string;
  matrixDomain:       string;   // z.B. "schule.prilog.team"
  webappDomain:       string;   // z.B. "schule.prilog.chat"
  dbPassword:         string;
  registrationSecret: string;
  macaroonSecret:     string;
  formSecret:         string;
  adminUsername:      string;
  adminPassword:      string;   // Klartext — nur beim Setup, wird danach gelöscht
  maxUploadSize:      number;   // MB, z.B. 50
  backendApiUrl:      string;   // z.B. "https://api.prilog.chat"
  agentToken:         string;   // Bearer Token für Ready-Callback
}

// ─── Step Result ──────────────────────────────────────────────────────────────

export interface StepResult {
  step:     StepName;
  status:   'success' | 'error' | 'skipped';
  message?: string;
  duration: number;  // Millisekunden
}

// ─── Provision Command (Backend → Agent) ─────────────────────────────────────

export interface ProvisionCommand {
  config:          ProvisionConfig;
  startFromStep?:  StepName;  // Für Retry: ab welchem Step starten?
}

// ─── Reporter Function ────────────────────────────────────────────────────────
// Wird vom Runner aufgerufen — sendet Status ans Backend via WebSocket.

export type ReportFn = (
  step:     StepName,
  status:   'running' | 'success' | 'error',
  message?: string,
) => void;

// ─── Step Function ────────────────────────────────────────────────────────────

export type StepFn = (config: ProvisionConfig) => Promise<void>;

export interface StepDefinition {
  name: StepName;
  fn:   StepFn;
}
