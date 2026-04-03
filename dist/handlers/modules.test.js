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
const fs = __importStar(require("fs"));
// Mock child_process and fs before importing the module under test
vitest_1.vi.mock('child_process', () => ({
    execSync: vitest_1.vi.fn(),
    exec: vitest_1.vi.fn(),
    spawn: vitest_1.vi.fn(),
}));
// We only mock specific fs functions; keep the rest real.
vitest_1.vi.mock('fs', async () => {
    const actual = await vitest_1.vi.importActual('fs');
    return {
        ...actual,
        existsSync: vitest_1.vi.fn(),
        readdirSync: vitest_1.vi.fn(),
        readFileSync: vitest_1.vi.fn(),
    };
});
// Suppress logger output during tests
vitest_1.vi.mock('../utils/logger.js', () => ({
    logger: {
        debug: vitest_1.vi.fn(),
        info: vitest_1.vi.fn(),
        warn: vitest_1.vi.fn(),
        error: vitest_1.vi.fn(),
    },
}));
const modules_js_1 = require("./modules.js");
const child_process_1 = require("child_process");
const existsSyncMock = vitest_1.vi.mocked(fs.existsSync);
const readdirSyncMock = vitest_1.vi.mocked(fs.readdirSync);
const readFileSyncMock = vitest_1.vi.mocked(fs.readFileSync);
const execSyncMock = vitest_1.vi.mocked(child_process_1.execSync);
(0, vitest_1.describe)('discoverModules', () => {
    (0, vitest_1.beforeEach)(() => {
        vitest_1.vi.clearAllMocks();
    });
    (0, vitest_1.it)('returns empty array when modules directory does not exist', () => {
        existsSyncMock.mockReturnValue(false);
        (0, vitest_1.expect)((0, modules_js_1.discoverModules)()).toEqual([]);
    });
    (0, vitest_1.it)('returns only directories that contain docker-compose.yml', () => {
        existsSyncMock.mockImplementation((path) => {
            const p = path.toString();
            if (p === '/opt/prilog/modules')
                return true;
            if (p === '/opt/prilog/modules/bridge-telegram/docker-compose.yml')
                return true;
            if (p === '/opt/prilog/modules/bridge-whatsapp/docker-compose.yml')
                return false;
            return false;
        });
        readdirSyncMock.mockReturnValue(['bridge-telegram', 'bridge-whatsapp']);
        const result = (0, modules_js_1.discoverModules)();
        (0, vitest_1.expect)(result).toEqual(['bridge-telegram']);
    });
});
(0, vitest_1.describe)('getModuleStatus', () => {
    (0, vitest_1.beforeEach)(() => {
        vitest_1.vi.clearAllMocks();
    });
    (0, vitest_1.it)('marks modules as running when their container name matches', () => {
        existsSyncMock.mockReturnValue(true);
        readdirSyncMock.mockReturnValue(['bridge-telegram']);
        execSyncMock.mockReturnValue(Buffer.from('bridge-telegram\n'));
        readFileSyncMock.mockReturnValue('image: dock.io/prilog/bridge-telegram:1.2.3');
        const result = (0, modules_js_1.getModuleStatus)();
        (0, vitest_1.expect)(result).toEqual([
            {
                name: 'bridge-telegram',
                enabled: true,
                running: true,
                version: '1.2.3',
            },
        ]);
    });
    (0, vitest_1.it)('marks modules as not running when docker ps returns empty', () => {
        existsSyncMock.mockReturnValue(true);
        readdirSyncMock.mockReturnValue(['my-module']);
        execSyncMock.mockReturnValue(Buffer.from(''));
        readFileSyncMock.mockReturnValue('image: foo/bar:latest');
        const result = (0, modules_js_1.getModuleStatus)();
        (0, vitest_1.expect)(result).toEqual([
            {
                name: 'my-module',
                enabled: false,
                running: false,
                version: 'latest',
            },
        ]);
    });
});
(0, vitest_1.describe)('enableModule / disableModule — input validation', () => {
    (0, vitest_1.beforeEach)(() => {
        vitest_1.vi.clearAllMocks();
    });
    (0, vitest_1.it)('rejects module names with path traversal characters', async () => {
        const result = await (0, modules_js_1.enableModule)('../etc/passwd');
        (0, vitest_1.expect)(result.success).toBe(false);
        (0, vitest_1.expect)(result.output).toMatch(/Ungültiger Modulname/i);
    });
    (0, vitest_1.it)('rejects module names with spaces', async () => {
        const result = await (0, modules_js_1.disableModule)('my module');
        (0, vitest_1.expect)(result.success).toBe(false);
        (0, vitest_1.expect)(result.output).toMatch(/Ungültiger Modulname/i);
    });
    (0, vitest_1.it)('rejects module names with uppercase letters', async () => {
        const result = await (0, modules_js_1.enableModule)('MyModule');
        (0, vitest_1.expect)(result.success).toBe(false);
        (0, vitest_1.expect)(result.output).toMatch(/Ungültiger Modulname/i);
    });
    (0, vitest_1.it)('accepts valid module names with lowercase, digits, hyphens, underscores', async () => {
        // It will fail because the compose file doesn't exist, but it passes validation
        existsSyncMock.mockReturnValue(false);
        const result = await (0, modules_js_1.enableModule)('bridge-telegram_2');
        (0, vitest_1.expect)(result.success).toBe(false);
        (0, vitest_1.expect)(result.output).toMatch(/nicht gefunden/);
    });
});
