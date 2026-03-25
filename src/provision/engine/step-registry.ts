/**
 * Dynamic step registration for provisioning.
 * Replaces the static STEPS array in runner.ts.
 */
import type { StepDefinition, StepName } from '../types.js';
import { logger } from '../../utils/logger.js';

export class StepRegistry {
  private steps: StepDefinition[] = [];

  /** Register a step. Throws if a step with the same name already exists. */
  register(step: StepDefinition): void {
    if (this.steps.some(s => s.name === step.name)) {
      throw new Error(`Step "${step.name}" is already registered`);
    }
    this.steps.push(step);
    logger.debug(`[StepRegistry] Registered step: ${step.name}`);
  }

  /** Return an immutable copy of all registered steps in order. */
  getAll(): readonly StepDefinition[] {
    return [...this.steps];
  }

  /** Find the index of a step by name. Returns -1 if not found. */
  findIndex(name: StepName): number {
    return this.steps.findIndex(s => s.name === name);
  }

  /** Number of registered steps. */
  get count(): number {
    return this.steps.length;
  }
}
