"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const vitest_1 = require("vitest");
const config_validator_js_1 = require("./config-validator.js");
/** Minimal valid config object — all required fields present. */
function validConfig(overrides = {}) {
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
(0, vitest_1.describe)('validateProvisionConfig', () => {
    (0, vitest_1.it)('accepts a valid config', () => {
        const result = (0, config_validator_js_1.validateProvisionConfig)(validConfig());
        (0, vitest_1.expect)(result.subdomain).toBe('meine-schule');
        (0, vitest_1.expect)(result.synapseBindAddress).toBe('0.0.0.0'); // default
    });
    (0, vitest_1.it)('accepts optional fields', () => {
        const result = (0, config_validator_js_1.validateProvisionConfig)(validConfig({ macaroonSecret: 'mac1', formSecret: 'form1' }));
        (0, vitest_1.expect)(result.macaroonSecret).toBe('mac1');
        (0, vitest_1.expect)(result.formSecret).toBe('form1');
    });
    // --- subdomain validation ---
    (0, vitest_1.it)('rejects subdomain with uppercase letters', () => {
        (0, vitest_1.expect)(() => (0, config_validator_js_1.validateProvisionConfig)(validConfig({ subdomain: 'MeineSchule' }))).toThrow();
    });
    (0, vitest_1.it)('rejects subdomain with spaces', () => {
        (0, vitest_1.expect)(() => (0, config_validator_js_1.validateProvisionConfig)(validConfig({ subdomain: 'meine schule' }))).toThrow();
    });
    (0, vitest_1.it)('rejects subdomain with special characters', () => {
        (0, vitest_1.expect)(() => (0, config_validator_js_1.validateProvisionConfig)(validConfig({ subdomain: 'schule!@#' }))).toThrow();
    });
    (0, vitest_1.it)('rejects subdomain with shell metacharacters', () => {
        (0, vitest_1.expect)(() => (0, config_validator_js_1.validateProvisionConfig)(validConfig({ subdomain: 'foo;rm -rf /' }))).toThrow();
    });
    // --- domain validation ---
    (0, vitest_1.it)('rejects domain with spaces', () => {
        (0, vitest_1.expect)(() => (0, config_validator_js_1.validateProvisionConfig)(validConfig({ matrixDomain: 'matrix domain.com' }))).toThrow();
    });
    (0, vitest_1.it)('rejects domain with uppercase', () => {
        (0, vitest_1.expect)(() => (0, config_validator_js_1.validateProvisionConfig)(validConfig({ webappDomain: 'App.Example.COM' }))).toThrow();
    });
    // --- username validation ---
    (0, vitest_1.it)('rejects username with shell injection', () => {
        (0, vitest_1.expect)(() => (0, config_validator_js_1.validateProvisionConfig)(validConfig({ adminUsername: 'admin; rm -rf /' }))).toThrow();
    });
    (0, vitest_1.it)('rejects username starting with a digit', () => {
        (0, vitest_1.expect)(() => (0, config_validator_js_1.validateProvisionConfig)(validConfig({ adminUsername: '1admin' }))).toThrow();
    });
    (0, vitest_1.it)('accepts username starting with underscore', () => {
        const result = (0, config_validator_js_1.validateProvisionConfig)(validConfig({ adminUsername: '_admin' }));
        (0, vitest_1.expect)(result.adminUsername).toBe('_admin');
    });
    // --- missing required fields ---
    (0, vitest_1.it)('rejects missing orderId', () => {
        const cfg = validConfig();
        delete cfg.orderId;
        (0, vitest_1.expect)(() => (0, config_validator_js_1.validateProvisionConfig)(cfg)).toThrow();
    });
    (0, vitest_1.it)('rejects missing subdomain', () => {
        const cfg = validConfig();
        delete cfg.subdomain;
        (0, vitest_1.expect)(() => (0, config_validator_js_1.validateProvisionConfig)(cfg)).toThrow();
    });
    (0, vitest_1.it)('rejects missing agentToken', () => {
        const cfg = validConfig();
        delete cfg.agentToken;
        (0, vitest_1.expect)(() => (0, config_validator_js_1.validateProvisionConfig)(cfg)).toThrow();
    });
    (0, vitest_1.it)('rejects empty orderId', () => {
        (0, vitest_1.expect)(() => (0, config_validator_js_1.validateProvisionConfig)(validConfig({ orderId: '' }))).toThrow();
    });
    // --- volumeId ---
    (0, vitest_1.it)('rejects non-numeric volumeId', () => {
        (0, vitest_1.expect)(() => (0, config_validator_js_1.validateProvisionConfig)(validConfig({ hetznerVolumeId: 'abc' }))).toThrow();
    });
    (0, vitest_1.it)('rejects volumeId with injection attempt', () => {
        (0, vitest_1.expect)(() => (0, config_validator_js_1.validateProvisionConfig)(validConfig({ hetznerVolumeId: '123; echo pwned' }))).toThrow();
    });
    // --- backendApiUrl ---
    (0, vitest_1.it)('rejects non-URL backendApiUrl', () => {
        (0, vitest_1.expect)(() => (0, config_validator_js_1.validateProvisionConfig)(validConfig({ backendApiUrl: 'not-a-url' }))).toThrow();
    });
    (0, vitest_1.it)('accepts https URL for backendApiUrl', () => {
        const result = (0, config_validator_js_1.validateProvisionConfig)(validConfig({ backendApiUrl: 'https://api.example.com/v1' }));
        (0, vitest_1.expect)(result.backendApiUrl).toBe('https://api.example.com/v1');
    });
    // --- maxUploadSize ---
    (0, vitest_1.it)('rejects zero maxUploadSize', () => {
        (0, vitest_1.expect)(() => (0, config_validator_js_1.validateProvisionConfig)(validConfig({ maxUploadSize: 0 }))).toThrow();
    });
    (0, vitest_1.it)('rejects maxUploadSize exceeding 1024', () => {
        (0, vitest_1.expect)(() => (0, config_validator_js_1.validateProvisionConfig)(validConfig({ maxUploadSize: 2000 }))).toThrow();
    });
});
