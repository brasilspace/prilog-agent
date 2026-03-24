import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as fs from 'fs';

// Mock child_process and fs before importing the module under test
vi.mock('child_process', () => ({
  execSync: vi.fn(),
  exec: vi.fn(),
  spawn: vi.fn(),
}));

// We only mock specific fs functions; keep the rest real.
vi.mock('fs', async () => {
  const actual = await vi.importActual<typeof import('fs')>('fs');
  return {
    ...actual,
    existsSync: vi.fn(),
    readdirSync: vi.fn(),
    readFileSync: vi.fn(),
  };
});

// Suppress logger output during tests
vi.mock('../utils/logger.js', () => ({
  logger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

import { discoverModules, getModuleStatus, enableModule, disableModule } from './modules.js';
import { execSync } from 'child_process';

const existsSyncMock = vi.mocked(fs.existsSync);
const readdirSyncMock = vi.mocked(fs.readdirSync);
const readFileSyncMock = vi.mocked(fs.readFileSync);
const execSyncMock = vi.mocked(execSync);

describe('discoverModules', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns empty array when modules directory does not exist', () => {
    existsSyncMock.mockReturnValue(false);
    expect(discoverModules()).toEqual([]);
  });

  it('returns only directories that contain docker-compose.yml', () => {
    existsSyncMock.mockImplementation((path: fs.PathLike) => {
      const p = path.toString();
      if (p === '/opt/synapse/modules') return true;
      if (p === '/opt/synapse/modules/bridge-telegram/docker-compose.yml') return true;
      if (p === '/opt/synapse/modules/bridge-whatsapp/docker-compose.yml') return false;
      return false;
    });
    readdirSyncMock.mockReturnValue(['bridge-telegram', 'bridge-whatsapp'] as any);

    const result = discoverModules();
    expect(result).toEqual(['bridge-telegram']);
  });
});

describe('getModuleStatus', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('marks modules as running when their container name matches', () => {
    existsSyncMock.mockReturnValue(true);
    readdirSyncMock.mockReturnValue(['bridge-telegram'] as any);
    execSyncMock.mockReturnValue(Buffer.from('bridge-telegram\n'));
    readFileSyncMock.mockReturnValue('image: dock.io/prilog/bridge-telegram:1.2.3');

    const result = getModuleStatus();
    expect(result).toEqual([
      {
        name: 'bridge-telegram',
        enabled: true,
        running: true,
        version: '1.2.3',
      },
    ]);
  });

  it('marks modules as not running when docker ps returns empty', () => {
    existsSyncMock.mockReturnValue(true);
    readdirSyncMock.mockReturnValue(['my-module'] as any);
    execSyncMock.mockReturnValue(Buffer.from(''));
    readFileSyncMock.mockReturnValue('image: foo/bar:latest');

    const result = getModuleStatus();
    expect(result).toEqual([
      {
        name: 'my-module',
        enabled: false,
        running: false,
        version: 'latest',
      },
    ]);
  });
});

describe('enableModule / disableModule — input validation', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('rejects module names with path traversal characters', async () => {
    const result = await enableModule('../etc/passwd');
    expect(result.success).toBe(false);
    expect(result.output).toMatch(/Ungültiger Modulname/i);
  });

  it('rejects module names with spaces', async () => {
    const result = await disableModule('my module');
    expect(result.success).toBe(false);
    expect(result.output).toMatch(/Ungültiger Modulname/i);
  });

  it('rejects module names with uppercase letters', async () => {
    const result = await enableModule('MyModule');
    expect(result.success).toBe(false);
    expect(result.output).toMatch(/Ungültiger Modulname/i);
  });

  it('accepts valid module names with lowercase, digits, hyphens, underscores', async () => {
    // It will fail because the compose file doesn't exist, but it passes validation
    existsSyncMock.mockReturnValue(false);
    const result = await enableModule('bridge-telegram_2');
    expect(result.success).toBe(false);
    expect(result.output).toMatch(/nicht gefunden/);
  });
});
