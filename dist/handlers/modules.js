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
exports.discoverModules = discoverModules;
exports.getModuleStatus = getModuleStatus;
exports.enableModule = enableModule;
exports.disableModule = disableModule;
const child_process_1 = require("child_process");
const fs = __importStar(require("fs"));
const logger_js_1 = require("../utils/logger.js");
const MODULES_DIR = '/opt/prilog/modules';
// ─── Verfügbare Module entdecken ─────────────────────────────────────────────
function discoverModules() {
    try {
        if (!fs.existsSync(MODULES_DIR))
            return [];
        return fs.readdirSync(MODULES_DIR).filter(name => {
            const composePath = `${MODULES_DIR}/${name}/docker-compose.yml`;
            return fs.existsSync(composePath);
        });
    }
    catch {
        return [];
    }
}
// ─── Status aller Module ──────────────────────────────────────────────────────
function getModuleStatus() {
    const discovered = discoverModules();
    // Laufende Container mit prilog.module Label
    let runningContainers = [];
    try {
        const out = (0, child_process_1.execSync)('docker ps --filter "label=prilog.module" --format "{{.Names}}"')
            .toString().trim();
        runningContainers = out ? out.split('\n') : [];
    }
    catch {
        // Docker nicht verfügbar
    }
    return discovered.map(name => {
        const running = runningContainers.some(c => c.includes(name));
        let version;
        try {
            const composePath = `${MODULES_DIR}/${name}/docker-compose.yml`;
            const content = fs.readFileSync(composePath, 'utf8');
            const match = content.match(/image:.*:([^\s]+)/);
            if (match)
                version = match[1];
        }
        catch {
            // kein version
        }
        return { name, enabled: running, running, version };
    });
}
// ─── Module ein-/ausschalten ─────────────────────────────────────────────────
async function enableModule(moduleName) {
    // Sicherheitscheck: kein Path Traversal
    if (!/^[a-z0-9_-]+$/.test(moduleName)) {
        return { success: false, output: 'Ungültiger Modulname' };
    }
    const composePath = `${MODULES_DIR}/${moduleName}/docker-compose.yml`;
    if (!fs.existsSync(composePath)) {
        return { success: false, output: `Modul nicht gefunden: ${moduleName}` };
    }
    try {
        const out = (0, child_process_1.execSync)(`docker compose -f ${composePath} up -d`, { timeout: 60_000 }).toString();
        logger_js_1.logger.info(`Module enabled: ${moduleName}`);
        return { success: true, output: out };
    }
    catch (err) {
        return { success: false, output: err?.message ?? 'Fehler' };
    }
}
async function disableModule(moduleName) {
    if (!/^[a-z0-9_-]+$/.test(moduleName)) {
        return { success: false, output: 'Ungültiger Modulname' };
    }
    const composePath = `${MODULES_DIR}/${moduleName}/docker-compose.yml`;
    if (!fs.existsSync(composePath)) {
        return { success: false, output: `Modul nicht gefunden: ${moduleName}` };
    }
    try {
        const out = (0, child_process_1.execSync)(`docker compose -f ${composePath} down`, { timeout: 30_000 }).toString();
        logger_js_1.logger.info(`Module disabled: ${moduleName}`);
        return { success: true, output: out };
    }
    catch (err) {
        return { success: false, output: err?.message ?? 'Fehler' };
    }
}
