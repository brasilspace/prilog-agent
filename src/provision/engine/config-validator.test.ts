import { describe, it, expect } from 'vitest';
import { validateProvisionConfig } from './config-validator.js';

/** Minimal valid config object — all required fields present. */
function validConfig(overrides: Record<string, unknown> = {}) {
  return {
    orderId: 'order-123',
    subdomain: 'meine-schule',
    matrixDomain: 'matrix.meine-schule.prilog.chat',
    webappDomain: 'app.meine-schule.prilog.chat',
    tailscaleAuthKey: 'tskey-auth-abc123',
    hetznerVolumeId: '98765',
    dbHost: 'db.internal',
    dbPassword: 'supersecret',
    registrationSecret: 'regsecret',
    adminUsername: 'admin_user',
    adminPasswordB64: 'cGFzc3dvcmQ=',
    maxUploadSize: 50,
    backendApiUrl: 'https://api.prilog.chat/api',
    agentToken: 'tok-xyz',
    ...overrides,
  };
}

describe('validateProvisionConfig', () => {
  it('accepts a valid config', () => {
    const result = validateProvisionConfig(validConfig());
    expect(result.subdomain).toBe('meine-schule');
    expect(result.synapseBindAddress).toBe('0.0.0.0'); // default
  });

  it('accepts optional fields', () => {
    const result = validateProvisionConfig(
      validConfig({ macaroonSecret: 'mac1', formSecret: 'form1' }),
    );
    expect(result.macaroonSecret).toBe('mac1');
    expect(result.formSecret).toBe('form1');
  });

  // --- subdomain validation ---

  it('rejects subdomain with uppercase letters', () => {
    expect(() => validateProvisionConfig(validConfig({ subdomain: 'MeineSchule' }))).toThrow();
  });

  it('rejects subdomain with spaces', () => {
    expect(() => validateProvisionConfig(validConfig({ subdomain: 'meine schule' }))).toThrow();
  });

  it('rejects subdomain with special characters', () => {
    expect(() => validateProvisionConfig(validConfig({ subdomain: 'schule!@#' }))).toThrow();
  });

  it('rejects subdomain with shell metacharacters', () => {
    expect(() => validateProvisionConfig(validConfig({ subdomain: 'foo;rm -rf /' }))).toThrow();
  });

  // --- domain validation ---

  it('rejects domain with spaces', () => {
    expect(() =>
      validateProvisionConfig(validConfig({ matrixDomain: 'matrix domain.com' })),
    ).toThrow();
  });

  it('rejects domain with uppercase', () => {
    expect(() =>
      validateProvisionConfig(validConfig({ webappDomain: 'App.Example.COM' })),
    ).toThrow();
  });

  // --- username validation ---

  it('rejects username with shell injection', () => {
    expect(() =>
      validateProvisionConfig(validConfig({ adminUsername: 'admin; rm -rf /' })),
    ).toThrow();
  });

  it('rejects username starting with a digit', () => {
    expect(() =>
      validateProvisionConfig(validConfig({ adminUsername: '1admin' })),
    ).toThrow();
  });

  it('accepts username starting with underscore', () => {
    const result = validateProvisionConfig(validConfig({ adminUsername: '_admin' }));
    expect(result.adminUsername).toBe('_admin');
  });

  // --- missing required fields ---

  it('rejects missing orderId', () => {
    const cfg = validConfig();
    delete (cfg as Record<string, unknown>).orderId;
    expect(() => validateProvisionConfig(cfg)).toThrow();
  });

  it('rejects missing subdomain', () => {
    const cfg = validConfig();
    delete (cfg as Record<string, unknown>).subdomain;
    expect(() => validateProvisionConfig(cfg)).toThrow();
  });

  it('rejects missing agentToken', () => {
    const cfg = validConfig();
    delete (cfg as Record<string, unknown>).agentToken;
    expect(() => validateProvisionConfig(cfg)).toThrow();
  });

  it('rejects empty orderId', () => {
    expect(() => validateProvisionConfig(validConfig({ orderId: '' }))).toThrow();
  });

  // --- volumeId ---

  it('rejects non-numeric volumeId', () => {
    expect(() =>
      validateProvisionConfig(validConfig({ hetznerVolumeId: 'abc' })),
    ).toThrow();
  });

  it('rejects volumeId with injection attempt', () => {
    expect(() =>
      validateProvisionConfig(validConfig({ hetznerVolumeId: '123; echo pwned' })),
    ).toThrow();
  });

  // --- backendApiUrl ---

  it('rejects non-URL backendApiUrl', () => {
    expect(() =>
      validateProvisionConfig(validConfig({ backendApiUrl: 'not-a-url' })),
    ).toThrow();
  });

  it('accepts https URL for backendApiUrl', () => {
    const result = validateProvisionConfig(
      validConfig({ backendApiUrl: 'https://api.example.com/v1' }),
    );
    expect(result.backendApiUrl).toBe('https://api.example.com/v1');
  });

  // --- maxUploadSize ---

  it('rejects zero maxUploadSize', () => {
    expect(() => validateProvisionConfig(validConfig({ maxUploadSize: 0 }))).toThrow();
  });

  it('rejects maxUploadSize exceeding 1024', () => {
    expect(() => validateProvisionConfig(validConfig({ maxUploadSize: 2000 }))).toThrow();
  });
});
