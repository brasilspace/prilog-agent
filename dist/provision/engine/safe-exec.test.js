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
// Mock the logger so tests don't produce console output
vitest_1.vi.mock('../../utils/logger.js', () => ({
    logger: {
        debug: vitest_1.vi.fn(),
        info: vitest_1.vi.fn(),
        warn: vitest_1.vi.fn(),
        error: vitest_1.vi.fn(),
    },
}));
const safe_exec_js_1 = require("./safe-exec.js");
(0, vitest_1.describe)('safeExec', () => {
    // --- basic execution ---
    (0, vitest_1.it)('runs a simple command and captures stdout', async () => {
        const result = await (0, safe_exec_js_1.safeExec)('echo', ['hello world']);
        (0, vitest_1.expect)(result.stdout.trim()).toBe('hello world');
        (0, vitest_1.expect)(result.exitCode).toBe(0);
    });
    (0, vitest_1.it)('captures stderr', async () => {
        // "ls" on a non-existent path writes to stderr and exits non-zero
        const result = await (0, safe_exec_js_1.safeExec)('ls', ['/nonexistent-path-xyz'], {
            ignoreExitCode: true,
        });
        (0, vitest_1.expect)(result.stderr.length).toBeGreaterThan(0);
        (0, vitest_1.expect)(result.exitCode).not.toBe(0);
    });
    (0, vitest_1.it)('passes multiple arguments correctly', async () => {
        const result = await (0, safe_exec_js_1.safeExec)('printf', ['%s-%s', 'foo', 'bar']);
        (0, vitest_1.expect)(result.stdout).toBe('foo-bar');
    });
    // --- non-zero exit code ---
    (0, vitest_1.it)('throws on non-zero exit code by default', async () => {
        await (0, vitest_1.expect)((0, safe_exec_js_1.safeExec)('false', [])).rejects.toThrow('exited with code');
    });
    (0, vitest_1.it)('includes command name in error message', async () => {
        await (0, vitest_1.expect)((0, safe_exec_js_1.safeExec)('false', [])).rejects.toThrow('"false"');
    });
    // --- ignoreExitCode ---
    (0, vitest_1.it)('does not throw when ignoreExitCode is true', async () => {
        const result = await (0, safe_exec_js_1.safeExec)('false', [], { ignoreExitCode: true });
        (0, vitest_1.expect)(result.exitCode).not.toBe(0);
    });
    // --- timeout ---
    (0, vitest_1.it)('throws on timeout', async () => {
        await (0, vitest_1.expect)((0, safe_exec_js_1.safeExec)('sleep', ['10'], { timeout: 100 })).rejects.toThrow('timed out');
    }, 5000);
    (0, vitest_1.it)('succeeds when command finishes before timeout', async () => {
        const result = await (0, safe_exec_js_1.safeExec)('echo', ['fast'], { timeout: 5000 });
        (0, vitest_1.expect)(result.stdout.trim()).toBe('fast');
    });
    // --- spawn error ---
    (0, vitest_1.it)('throws when command does not exist', async () => {
        await (0, vitest_1.expect)((0, safe_exec_js_1.safeExec)('nonexistent-command-xyz-12345', [])).rejects.toThrow('Failed to spawn');
    });
    // --- cwd option ---
    (0, vitest_1.it)('respects cwd option', async () => {
        const result = await (0, safe_exec_js_1.safeExec)('pwd', [], { cwd: '/tmp' });
        (0, vitest_1.expect)(result.stdout.trim()).toBe('/tmp');
    });
    // --- env option ---
    (0, vitest_1.it)('passes custom environment variables', async () => {
        const result = await (0, safe_exec_js_1.safeExec)('env', [], {
            env: { MY_TEST_VAR: 'test-value-42' },
        });
        (0, vitest_1.expect)(result.stdout).toContain('MY_TEST_VAR=test-value-42');
    });
    // --- sensitive argument masking (tested indirectly via logger) ---
    (0, vitest_1.it)('masks sensitive arguments in log output', async () => {
        const { logger } = await Promise.resolve().then(() => __importStar(require('../../utils/logger.js')));
        vitest_1.vi.mocked(logger.info).mockClear();
        await (0, safe_exec_js_1.safeExec)('echo', ['--authkey=secret123', 'normal-arg']);
        const logCall = vitest_1.vi.mocked(logger.info).mock.calls.find(call => typeof call[0] === 'string' && call[0].includes('[safe-exec]'));
        (0, vitest_1.expect)(logCall).toBeDefined();
        const logMessage = logCall[0];
        (0, vitest_1.expect)(logMessage).toContain('--authkey=****');
        (0, vitest_1.expect)(logMessage).not.toContain('secret123');
        (0, vitest_1.expect)(logMessage).toContain('normal-arg');
    });
    (0, vitest_1.it)('masks Bearer tokens in log output', async () => {
        const { logger } = await Promise.resolve().then(() => __importStar(require('../../utils/logger.js')));
        vitest_1.vi.mocked(logger.info).mockClear();
        await (0, safe_exec_js_1.safeExec)('echo', ['Bearer my-secret-token']);
        const logCall = vitest_1.vi.mocked(logger.info).mock.calls.find(call => typeof call[0] === 'string' && call[0].includes('[safe-exec]'));
        (0, vitest_1.expect)(logCall).toBeDefined();
        const logMessage = logCall[0];
        (0, vitest_1.expect)(logMessage).toContain('Bearer ****');
        (0, vitest_1.expect)(logMessage).not.toContain('my-secret-token');
    });
});
