"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const vitest_1 = require("vitest");
// Mock the logger so tests don't produce console output
vitest_1.vi.mock('../../utils/logger.js', () => ({
    logger: {
        debug: vitest_1.vi.fn(),
        info: vitest_1.vi.fn(),
        warn: vitest_1.vi.fn(),
        error: vitest_1.vi.fn(),
    },
}));
const step_registry_js_1 = require("./step-registry.js");
/** Create a minimal StepDefinition for testing. */
function makeStep(name) {
    return {
        name,
        fn: vitest_1.vi.fn().mockResolvedValue(undefined),
        verify: vitest_1.vi.fn().mockResolvedValue(undefined),
    };
}
(0, vitest_1.describe)('StepRegistry', () => {
    let registry;
    (0, vitest_1.beforeEach)(() => {
        registry = new step_registry_js_1.StepRegistry();
    });
    (0, vitest_1.it)('register() adds a step', () => {
        registry.register(makeStep('install_docker'));
        (0, vitest_1.expect)(registry.count).toBe(1);
    });
    (0, vitest_1.it)('register() adds multiple steps', () => {
        registry.register(makeStep('install_docker'));
        registry.register(makeStep('configure_firewall'));
        registry.register(makeStep('setup_tailscale'));
        (0, vitest_1.expect)(registry.count).toBe(3);
    });
    (0, vitest_1.it)('getAll() returns all registered steps in order', () => {
        const steps = ['install_docker', 'configure_firewall', 'setup_tailscale'];
        steps.forEach(name => registry.register(makeStep(name)));
        const all = registry.getAll();
        (0, vitest_1.expect)(all).toHaveLength(3);
        (0, vitest_1.expect)(all[0].name).toBe('install_docker');
        (0, vitest_1.expect)(all[1].name).toBe('configure_firewall');
        (0, vitest_1.expect)(all[2].name).toBe('setup_tailscale');
    });
    (0, vitest_1.it)('getAll() returns an independent copy (not a reference)', () => {
        registry.register(makeStep('install_docker'));
        const all1 = registry.getAll();
        registry.register(makeStep('configure_firewall'));
        const all2 = registry.getAll();
        // First snapshot should still be length 1
        (0, vitest_1.expect)(all1).toHaveLength(1);
        (0, vitest_1.expect)(all2).toHaveLength(2);
    });
    (0, vitest_1.it)('findIndex() returns the correct index', () => {
        registry.register(makeStep('install_docker'));
        registry.register(makeStep('configure_firewall'));
        registry.register(makeStep('setup_tailscale'));
        (0, vitest_1.expect)(registry.findIndex('install_docker')).toBe(0);
        (0, vitest_1.expect)(registry.findIndex('configure_firewall')).toBe(1);
        (0, vitest_1.expect)(registry.findIndex('setup_tailscale')).toBe(2);
    });
    (0, vitest_1.it)('findIndex() returns -1 for unknown step', () => {
        registry.register(makeStep('install_docker'));
        (0, vitest_1.expect)(registry.findIndex('finalize')).toBe(-1);
    });
    (0, vitest_1.it)('throws on duplicate name registration', () => {
        registry.register(makeStep('install_docker'));
        (0, vitest_1.expect)(() => registry.register(makeStep('install_docker'))).toThrow('Step "install_docker" is already registered');
    });
    (0, vitest_1.it)('count returns 0 for empty registry', () => {
        (0, vitest_1.expect)(registry.count).toBe(0);
    });
    (0, vitest_1.it)('count returns correct number after multiple registrations', () => {
        registry.register(makeStep('mount_volume'));
        registry.register(makeStep('install_nginx'));
        (0, vitest_1.expect)(registry.count).toBe(2);
    });
});
