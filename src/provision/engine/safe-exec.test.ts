import { describe, it, expect, vi } from 'vitest';

// Mock the logger so tests don't produce console output
vi.mock('../../utils/logger.js', () => ({
  logger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

import { safeExec } from './safe-exec.js';

describe('safeExec', () => {
  // --- basic execution ---

  it('runs a simple command and captures stdout', async () => {
    const result = await safeExec('echo', ['hello world']);
    expect(result.stdout.trim()).toBe('hello world');
    expect(result.exitCode).toBe(0);
  });

  it('captures stderr', async () => {
    // "ls" on a non-existent path writes to stderr and exits non-zero
    const result = await safeExec('ls', ['/nonexistent-path-xyz'], {
      ignoreExitCode: true,
    });
    expect(result.stderr.length).toBeGreaterThan(0);
    expect(result.exitCode).not.toBe(0);
  });

  it('passes multiple arguments correctly', async () => {
    const result = await safeExec('printf', ['%s-%s', 'foo', 'bar']);
    expect(result.stdout).toBe('foo-bar');
  });

  // --- non-zero exit code ---

  it('throws on non-zero exit code by default', async () => {
    await expect(safeExec('false', [])).rejects.toThrow('exited with code');
  });

  it('includes command name in error message', async () => {
    await expect(safeExec('false', [])).rejects.toThrow('"false"');
  });

  // --- ignoreExitCode ---

  it('does not throw when ignoreExitCode is true', async () => {
    const result = await safeExec('false', [], { ignoreExitCode: true });
    expect(result.exitCode).not.toBe(0);
  });

  // --- timeout ---

  it('throws on timeout', async () => {
    await expect(
      safeExec('sleep', ['10'], { timeout: 100 }),
    ).rejects.toThrow('timed out');
  }, 5000);

  it('succeeds when command finishes before timeout', async () => {
    const result = await safeExec('echo', ['fast'], { timeout: 5000 });
    expect(result.stdout.trim()).toBe('fast');
  });

  // --- spawn error ---

  it('throws when command does not exist', async () => {
    await expect(
      safeExec('nonexistent-command-xyz-12345', []),
    ).rejects.toThrow('Failed to spawn');
  });

  // --- cwd option ---

  it('respects cwd option', async () => {
    const result = await safeExec('pwd', [], { cwd: '/tmp' });
    expect(result.stdout.trim()).toBe('/tmp');
  });

  // --- env option ---

  it('passes custom environment variables', async () => {
    const result = await safeExec('env', [], {
      env: { MY_TEST_VAR: 'test-value-42' },
    });
    expect(result.stdout).toContain('MY_TEST_VAR=test-value-42');
  });

  // --- sensitive argument masking (tested indirectly via logger) ---

  it('masks sensitive arguments in log output', async () => {
    const { logger } = await import('../../utils/logger.js');
    vi.mocked(logger.info).mockClear();

    await safeExec('echo', ['--authkey=secret123', 'normal-arg']);

    const logCall = vi.mocked(logger.info).mock.calls.find(
      call => typeof call[0] === 'string' && call[0].includes('[safe-exec]'),
    );
    expect(logCall).toBeDefined();
    const logMessage = logCall![0] as string;
    expect(logMessage).toContain('--authkey=****');
    expect(logMessage).not.toContain('secret123');
    expect(logMessage).toContain('normal-arg');
  });

  it('masks Bearer tokens in log output', async () => {
    const { logger } = await import('../../utils/logger.js');
    vi.mocked(logger.info).mockClear();

    await safeExec('echo', ['Bearer my-secret-token']);

    const logCall = vi.mocked(logger.info).mock.calls.find(
      call => typeof call[0] === 'string' && call[0].includes('[safe-exec]'),
    );
    expect(logCall).toBeDefined();
    const logMessage = logCall![0] as string;
    expect(logMessage).toContain('Bearer ****');
    expect(logMessage).not.toContain('my-secret-token');
  });
});
