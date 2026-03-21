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
  'install_matrix_connector',
  'write_compose',
  'start_containers',
  'get_ssl',
  'configure_nginx_ssl',
  'create_admin_user',
  'finalize',
] as const;

export type StepName = typeof STEP_NAMES[number];

export type StepStatus = 'pending' | 'running' | 'success' | 'error' | 'skipped';

export interface SynapseModuleInstallPlanEntry {
  name: string;
  displayName: string;
  category: string;
  enabled: boolean;
  enabledByDefault: boolean;
  visibleInPortal: boolean;
}

export interface EnabledSynapseModuleSummary {
  name: string;
  displayName: string;
  category: string;
  enabledByDefault: boolean;
  visibleInPortal: boolean;
}

export interface MatrixConnectorRuntimeConfig {
  prilogApiUrl: string;
  tenantId?: string;
  tenantKey?: string;
  subdomain?: string;
  sharedSecret: string;
  sharedSecretEnv?: string;
  allowServerAdminBypass: boolean;
  requestTimeoutSeconds: number;
}

export interface MatrixConnectorModuleConfig {
  enabled: boolean;
  moduleName: string;
  moduleClass: string;
  packageUrl?: string;
  packageRepo: string;
  packageRef?: string;
  config: MatrixConnectorRuntimeConfig;
}

export interface SynapseModulesConfig {
  installPlan: SynapseModuleInstallPlanEntry[];
  enabledModules: EnabledSynapseModuleSummary[];
  connector: MatrixConnectorModuleConfig | null;
}

export interface ProvisionConfig {
  orderId:            string;
  subdomain:          string;
  matrixDomain:       string;
  webappDomain:       string;
  tailscaleAuthKey:   string;
  hetznerVolumeId:    string;
  dbHost:             string;
  dbPassword:         string;
  registrationSecret: string;
  macaroonSecret:     string;
  formSecret:         string;
  adminUsername:      string;
  adminPasswordB64:   string;  // Base64-kodiert — vor Shell-Aufruf dekodieren!
  maxUploadSize:      number;
  backendApiUrl:      string;
  agentToken:         string;
  synapseModules?:    SynapseModulesConfig;
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

export type StepFn   = (config: ProvisionConfig) => Promise<void>;
export type VerifyFn = (config: ProvisionConfig) => Promise<void>;

export interface StepDefinition {
  name:   StepName;
  fn:     StepFn;
  verify: VerifyFn;  // Wird nach fn() aufgerufen — wirft Error wenn fehlgeschlagen
}
