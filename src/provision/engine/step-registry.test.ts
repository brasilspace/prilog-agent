import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { StepDefinition, StepName } from '../types.js';

// Mock the logger so tests don't produce console output
vi.mock('../../utils/logger.js', () => ({
  logger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

import { StepRegistry } from './step-registry.js';

/** Create a minimal StepDefinition for testing. */
function makeStep(name: StepName): StepDefinition {
  return {
    name,
    fn: vi.fn().mockResolvedValue(undefined),
    verify: vi.fn().mockResolvedValue(undefined),
  };
}

describe('StepRegistry', () => {
  let registry: StepRegistry;

  beforeEach(() => {
    registry = new StepRegistry();
  });

  it('register() adds a step', () => {
    registry.register(makeStep('install_docker'));
    expect(registry.count).toBe(1);
  });

  it('register() adds multiple steps', () => {
    registry.register(makeStep('install_docker'));
    registry.register(makeStep('configure_firewall'));
    registry.register(makeStep('setup_tailscale'));
    expect(registry.count).toBe(3);
  });

  it('getAll() returns all registered steps in order', () => {
    const steps: StepName[] = ['install_docker', 'configure_firewall', 'setup_tailscale'];
    steps.forEach(name => registry.register(makeStep(name)));

    const all = registry.getAll();
    expect(all).toHaveLength(3);
    expect(all[0].name).toBe('install_docker');
    expect(all[1].name).toBe('configure_firewall');
    expect(all[2].name).toBe('setup_tailscale');
  });

  it('getAll() returns an independent copy (not a reference)', () => {
    registry.register(makeStep('install_docker'));
    const all1 = registry.getAll();
    registry.register(makeStep('configure_firewall'));
    const all2 = registry.getAll();

    // First snapshot should still be length 1
    expect(all1).toHaveLength(1);
    expect(all2).toHaveLength(2);
  });

  it('findIndex() returns the correct index', () => {
    registry.register(makeStep('install_docker'));
    registry.register(makeStep('configure_firewall'));
    registry.register(makeStep('setup_tailscale'));

    expect(registry.findIndex('install_docker')).toBe(0);
    expect(registry.findIndex('configure_firewall')).toBe(1);
    expect(registry.findIndex('setup_tailscale')).toBe(2);
  });

  it('findIndex() returns -1 for unknown step', () => {
    registry.register(makeStep('install_docker'));
    expect(registry.findIndex('finalize')).toBe(-1);
  });

  it('throws on duplicate name registration', () => {
    registry.register(makeStep('install_docker'));
    expect(() => registry.register(makeStep('install_docker'))).toThrow(
      'Step "install_docker" is already registered',
    );
  });

  it('count returns 0 for empty registry', () => {
    expect(registry.count).toBe(0);
  });

  it('count returns correct number after multiple registrations', () => {
    registry.register(makeStep('mount_volume'));
    registry.register(makeStep('install_nginx'));
    expect(registry.count).toBe(2);
  });
});
