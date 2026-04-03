"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
const vitest_1 = require("vitest");
// We need to test the logger module which reads LOG_LEVEL from process.env at
// module load time.  To test different log levels we dynamically import a fresh
// copy each time.
function freshImport(level) {
    // Reset the module registry so logger.ts re-evaluates
    vitest_1.vi.resetModules();
    if (level) {
        process.env.LOG_LEVEL = level;
    }
    else {
        delete process.env.LOG_LEVEL;
    }
    return Promise.resolve().then(() => __importStar(require('./logger.js')));
}
(0, vitest_1.describe)('logger', () => {
    let consoleSpy;
    let consoleErrorSpy;
    const savedLevel = process.env.LOG_LEVEL;
    (0, vitest_1.beforeEach)(() => {
        consoleSpy = vitest_1.vi.spyOn(console, 'log').mockImplementation(() => { });
        consoleErrorSpy = vitest_1.vi.spyOn(console, 'error').mockImplementation(() => { });
    });
    (0, vitest_1.afterEach)(() => {
        consoleSpy.mockRestore();
        consoleErrorSpy.mockRestore();
        if (savedLevel !== undefined) {
            process.env.LOG_LEVEL = savedLevel;
        }
        else {
            delete process.env.LOG_LEVEL;
        }
    });
    (0, vitest_1.it)('logs info messages by default (LOG_LEVEL unset)', async () => {
        const { logger } = await freshImport();
        logger.info('hello world');
        (0, vitest_1.expect)(consoleSpy).toHaveBeenCalledOnce();
        (0, vitest_1.expect)(consoleSpy.mock.calls[0][0]).toMatch(/\[INFO\] hello world/);
    });
    (0, vitest_1.it)('suppresses debug when LOG_LEVEL is info', async () => {
        const { logger } = await freshImport('info');
        logger.debug('should not appear');
        (0, vitest_1.expect)(consoleSpy).not.toHaveBeenCalled();
    });
    (0, vitest_1.it)('shows debug when LOG_LEVEL is debug', async () => {
        const { logger } = await freshImport('debug');
        logger.debug('visible');
        (0, vitest_1.expect)(consoleSpy).toHaveBeenCalledOnce();
        (0, vitest_1.expect)(consoleSpy.mock.calls[0][0]).toMatch(/\[DEBUG\] visible/);
    });
    (0, vitest_1.it)('routes error level to console.error', async () => {
        const { logger } = await freshImport('info');
        logger.error('something broke');
        (0, vitest_1.expect)(consoleErrorSpy).toHaveBeenCalledOnce();
        (0, vitest_1.expect)(consoleErrorSpy.mock.calls[0][0]).toMatch(/\[ERROR\] something broke/);
    });
    (0, vitest_1.it)('includes ISO timestamp in output', async () => {
        const { logger } = await freshImport('info');
        logger.info('ts check');
        const output = consoleSpy.mock.calls[0][0];
        // ISO timestamp pattern: 2024-01-01T00:00:00.000Z
        (0, vitest_1.expect)(output).toMatch(/\[\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
    });
    (0, vitest_1.it)('passes extra data argument when provided', async () => {
        const { logger } = await freshImport('info');
        const extra = { foo: 'bar' };
        logger.warn('with data', extra);
        (0, vitest_1.expect)(consoleSpy).toHaveBeenCalledWith(vitest_1.expect.stringMatching(/\[WARN\] with data/), extra);
    });
    (0, vitest_1.it)('respects level hierarchy — warn suppresses info', async () => {
        const { logger } = await freshImport('warn');
        logger.info('nope');
        logger.warn('yes');
        (0, vitest_1.expect)(consoleSpy).toHaveBeenCalledOnce();
        (0, vitest_1.expect)(consoleSpy.mock.calls[0][0]).toMatch(/\[WARN\] yes/);
    });
});
