"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.validateProvisionConfig = validateProvisionConfig;
/**
 * Zod-based config validation for provisioning.
 * Validates and sanitises ProvisionConfig before any shell commands run.
 */
const zod_1 = require("zod");
// Safe patterns for shell-sensitive fields
const subdomainPattern = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/;
const domainPattern = /^[a-z0-9]([a-z0-9.-]*[a-z0-9])?$/;
const usernamePattern = /^[a-z_][a-z0-9_.-]{0,63}$/;
const provisionConfigSchema = zod_1.z.object({
    orderId: zod_1.z.string().min(1),
    subdomain: zod_1.z.string().regex(subdomainPattern, 'Ungültiger Subdomain-Name'),
    matrixDomain: zod_1.z.string().regex(domainPattern, 'Ungültiger Matrix-Domain-Name'),
    webappDomain: zod_1.z.string().regex(domainPattern, 'Ungültiger Webapp-Domain-Name'),
    synapseBindAddress: zod_1.z.string().ip().optional().default('0.0.0.0'),
    tailscaleAuthKey: zod_1.z.string().min(1).regex(/^[a-zA-Z0-9-]+$/, 'Ungültiger Tailscale-Key'),
    hetznerVolumeId: zod_1.z.string().regex(/^[0-9]+$/, 'Volume-ID muss numerisch sein'),
    dbHost: zod_1.z.string().regex(domainPattern, 'Ungültiger DB-Host'),
    dbPassword: zod_1.z.string().min(1),
    registrationSecret: zod_1.z.string().min(1),
    macaroonSecret: zod_1.z.string().min(1).optional(),
    formSecret: zod_1.z.string().min(1).optional(),
    adminUsername: zod_1.z.string().regex(usernamePattern, 'Ungültiger Admin-Username'),
    adminPasswordB64: zod_1.z.string().min(1),
    maxUploadSize: zod_1.z.number().positive().max(1024),
    backendApiUrl: zod_1.z.string().url(),
    agentToken: zod_1.z.string().min(1),
    synapseModules: zod_1.z.any().optional(), // Validated separately if present
    webClientArtifactUrl: zod_1.z.string().url().optional(),
});
/**
 * Validate raw provisioning config against the schema.
 * Throws ZodError with detailed messages on invalid input.
 */
function validateProvisionConfig(raw) {
    return provisionConfigSchema.parse(raw);
}
