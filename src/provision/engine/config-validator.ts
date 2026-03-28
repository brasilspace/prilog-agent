/**
 * Zod-based config validation for provisioning.
 * Validates and sanitises ProvisionConfig before any shell commands run.
 */
import { z } from 'zod';

// Safe patterns for shell-sensitive fields
const subdomainPattern = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/;
const domainPattern = /^[a-z0-9]([a-z0-9.-]*[a-z0-9])?$/;
const usernamePattern = /^[a-z_][a-z0-9_.-]{0,63}$/;

const provisionConfigSchema = z.object({
  orderId:            z.string().min(1),
  subdomain:          z.string().regex(subdomainPattern, 'Ungültiger Subdomain-Name'),
  matrixDomain:       z.string().regex(domainPattern, 'Ungültiger Matrix-Domain-Name'),
  webappDomain:       z.string().regex(domainPattern, 'Ungültiger Webapp-Domain-Name'),
  synapseBindAddress: z.string().ip().optional().default('0.0.0.0'),
  tailscaleAuthKey:   z.string().min(1).regex(/^[a-zA-Z0-9-]+$/, 'Ungültiger Tailscale-Key'),
  hetznerVolumeId:    z.string().regex(/^[0-9]+$/, 'Volume-ID muss numerisch sein'),
  dbHost:             z.string().regex(domainPattern, 'Ungültiger DB-Host'),
  dbPassword:         z.string().min(1),
  registrationSecret: z.string().min(1),
  macaroonSecret:     z.string().min(1).optional(),
  formSecret:         z.string().min(1).optional(),
  adminUsername:      z.string().regex(usernamePattern, 'Ungültiger Admin-Username'),
  adminPasswordB64:   z.string().min(1),
  maxUploadSize:      z.number().positive().max(1024),
  backendApiUrl:      z.string().url(),
  agentToken:         z.string().min(1),
  synapseModules:     z.any().optional(),  // Validated separately if present
  webClientArtifactUrl: z.string().url().optional(),
});

export type ValidatedProvisionConfig = z.infer<typeof provisionConfigSchema>;

/**
 * Validate raw provisioning config against the schema.
 * Throws ZodError with detailed messages on invalid input.
 */
export function validateProvisionConfig(raw: unknown): ValidatedProvisionConfig {
  return provisionConfigSchema.parse(raw);
}
