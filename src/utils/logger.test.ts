import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// We need to test the logger module which reads LOG_LEVEL from process.env at
// module load time.  To test different log levels we dynamically import a fresh
// copy each time.

function freshImport(level?: string) {
  // Reset the module registry so logger.ts re-evaluates
  vi.resetModules();
  if (level) {
    process.env.LOG_LEVEL = level;
  } else {
    delete process.env.LOG_LEVEL;
  }
  return import('./logger.js');
}

describe('logger', () => {
  let consoleSpy: ReturnType<typeof vi.spyOn>;
  let consoleErrorSpy: ReturnType<typeof vi.spyOn>;
  const savedLevel = process.env.LOG_LEVEL;

  beforeEach(() => {
    consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    consoleSpy.mockRestore();
    consoleErrorSpy.mockRestore();
    if (savedLevel !== undefined) {
      process.env.LOG_LEVEL = savedLevel;
    } else {
      delete process.env.LOG_LEVEL;
    }
  });

  it('logs info messages by default (LOG_LEVEL unset)', async () => {
    const { logger } = await freshImport();
    logger.info('hello world');
    expect(consoleSpy).toHaveBeenCalledOnce();
    expect(consoleSpy.mock.calls[0][0]).toMatch(/\[INFO\] hello world/);
  });

  it('suppresses debug when LOG_LEVEL is info', async () => {
    const { logger } = await freshImport('info');
    logger.debug('should not appear');
    expect(consoleSpy).not.toHaveBeenCalled();
  });

  it('shows debug when LOG_LEVEL is debug', async () => {
    const { logger } = await freshImport('debug');
    logger.debug('visible');
    expect(consoleSpy).toHaveBeenCalledOnce();
    expect(consoleSpy.mock.calls[0][0]).toMatch(/\[DEBUG\] visible/);
  });

  it('routes error level to console.error', async () => {
    const { logger } = await freshImport('info');
    logger.error('something broke');
    expect(consoleErrorSpy).toHaveBeenCalledOnce();
    expect(consoleErrorSpy.mock.calls[0][0]).toMatch(/\[ERROR\] something broke/);
  });

  it('includes ISO timestamp in output', async () => {
    const { logger } = await freshImport('info');
    logger.info('ts check');
    const output = consoleSpy.mock.calls[0][0] as string;
    // ISO timestamp pattern: 2024-01-01T00:00:00.000Z
    expect(output).toMatch(/\[\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
  });

  it('passes extra data argument when provided', async () => {
    const { logger } = await freshImport('info');
    const extra = { foo: 'bar' };
    logger.warn('with data', extra);
    expect(consoleSpy).toHaveBeenCalledWith(expect.stringMatching(/\[WARN\] with data/), extra);
  });

  it('respects level hierarchy — warn suppresses info', async () => {
    const { logger } = await freshImport('warn');
    logger.info('nope');
    logger.warn('yes');
    expect(consoleSpy).toHaveBeenCalledOnce();
    expect(consoleSpy.mock.calls[0][0]).toMatch(/\[WARN\] yes/);
  });
});
