/**
 * provision/types.ts
 */

export const STEP_NAMES = [
  'install_docker',
  'configure_firewall',
  'setup_tailscale',
  'mount_volume',
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

export interface ProvisionConfig {
  orderId:            string;
  subdomain:          string;
  matrixDomain:       string;
  webappDomain:       string;
  tailscaleAuthKey:   string;   // für setup_tailscale Step
  dbPassword:         string;
  registrationSecret: string;
  macaroonSecret:     string;
  formSecret:         string;
  adminUsername:      string;
  adminPassword:      string;
  maxUploadSize:      number;
  backendApiUrl:      string;
  agentToken:         string;
}

export interface StepResult {
  step:     StepName;
  status:   'success' | 'error' | 'skipped';
  message?: string;
  duration: number;
}

export interface ProvisionCommand {
  config:         ProvisionConfig;
  startFromStep?: StepName;
}

export type ReportFn = (
  step:     StepName,
  status:   'running' | 'success' | 'error',
  message?: string,
) => void;

export type StepFn = (config: ProvisionConfig) => Promise<void>;

export interface StepDefinition {
  name: StepName;
  fn:   StepFn;
}
