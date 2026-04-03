"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.StepRegistry = void 0;
const logger_js_1 = require("../../utils/logger.js");
class StepRegistry {
    steps = [];
    /** Register a step. Throws if a step with the same name already exists. */
    register(step) {
        if (this.steps.some(s => s.name === step.name)) {
            throw new Error(`Step "${step.name}" is already registered`);
        }
        this.steps.push(step);
        logger_js_1.logger.debug(`[StepRegistry] Registered step: ${step.name}`);
    }
    /** Return an immutable copy of all registered steps in order. */
    getAll() {
        return [...this.steps];
    }
    /** Find the index of a step by name. Returns -1 if not found. */
    findIndex(name) {
        return this.steps.findIndex(s => s.name === name);
    }
    /** Number of registered steps. */
    get count() {
        return this.steps.length;
    }
}
exports.StepRegistry = StepRegistry;
