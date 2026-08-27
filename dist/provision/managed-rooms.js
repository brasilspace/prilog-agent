"use strict";
/**
 * provision/managed-rooms.ts
 *
 * Installiert und konfiguriert `synapse-managed-rooms` idempotent — das Modul,
 * das die sechs Wege schliesst, auf denen an Prilog vorbei Raeume entstehen,
 * Leute eingeladen oder Raeume auffindbar gemacht werden.
 *
 * Aufbau bewusst wie bei connector.ts: Artefakt laden, entpacken, Modulblock in
 * homeserver.yaml setzen, spaeterer Compose-Step mountet ins Synapse-Zimmer.
 * Wer das eine versteht, versteht das andere.
 *
 * Der Agent rechnet hier NICHTS aus. deny, exempt und die beiden Schalter
 * kommen fertig aus dem Backend — die Dienstkonten-Muster sind die Stelle, an
 * der ein Fehler den Tenant aussperrt, und die gehoert an EINEN Ort.
 */
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
exports.getEnabledManagedRooms = getEnabledManagedRooms;
exports.ensureManagedRoomsInstalled = ensureManagedRoomsInstalled;
exports.verifyManagedRoomsInstalled = verifyManagedRoomsInstalled;
const fs = __importStar(require("fs"));
const yaml_1 = require("yaml");
const logger_js_1 = require("../utils/logger.js");
const compose_js_1 = require("./compose.js");
const safe_exec_js_1 = require("./engine/safe-exec.js");
const HOMESERVER_YAML = '/mnt/prilog-data/synapse/homeserver.yaml';
const MODULE_CLASS = 'synapse_managed_rooms.ManagedRoomsModule';
const TMP_ARCHIVE = '/tmp/synapse-managed-rooms.tar.gz';
function getEnabledManagedRooms(config) {
    const managedRooms = config.synapseModules?.managedRooms;
    if (!managedRooms?.enabled)
        return null;
    return managedRooms;
}
async function ensureArtifactExtracted(url) {
    fs.mkdirSync('/opt/prilog/modules', { recursive: true });
    if (fs.existsSync(compose_js_1.MANAGED_ROOMS_HOST_DIR)) {
        fs.rmSync(compose_js_1.MANAGED_ROOMS_HOST_DIR, { recursive: true, force: true });
    }
    if (fs.existsSync(TMP_ARCHIVE)) {
        fs.unlinkSync(TMP_ARCHIVE);
    }
    try {
        await (0, safe_exec_js_1.safeExec)('curl', ['-fsSL', url, '-o', TMP_ARCHIVE], { timeout: 120_000 });
    }
    catch {
        throw new Error(`managed-rooms-Artefakt konnte nicht geladen werden: ${url}`);
    }
    fs.mkdirSync(compose_js_1.MANAGED_ROOMS_HOST_DIR, { recursive: true });
    await (0, safe_exec_js_1.safeExec)('tar', ['-xzf', TMP_ARCHIVE, '-C', compose_js_1.MANAGED_ROOMS_HOST_DIR, '--strip-components=1'], { timeout: 120_000 });
}
function verifyExtracted() {
    const required = [
        `${compose_js_1.MANAGED_ROOMS_HOST_DIR}/synapse_managed_rooms/module.py`,
        `${compose_js_1.MANAGED_ROOMS_HOST_DIR}/synapse_managed_rooms/config.py`,
        `${compose_js_1.MANAGED_ROOMS_HOST_DIR}/synapse_managed_rooms/direct_messages.py`,
    ];
    for (const file of required) {
        if (!fs.existsSync(file)) {
            throw new Error(`managed-rooms-Datei fehlt nach Entpacken: ${file}`);
        }
    }
}
function ensureModulesNode(doc) {
    const existing = doc.get('modules', true);
    if (existing instanceof yaml_1.YAMLSeq) {
        return existing;
    }
    const modules = doc.createNode([]);
    doc.set('modules', modules);
    return modules;
}
function upsertModuleBlock(config) {
    if (!fs.existsSync(HOMESERVER_YAML)) {
        throw new Error(`homeserver.yaml fehlt: ${HOMESERVER_YAML}`);
    }
    const doc = (0, yaml_1.parseDocument)(fs.readFileSync(HOMESERVER_YAML, 'utf-8'));
    const modules = ensureModulesNode(doc);
    const managedRooms = getEnabledManagedRooms(config);
    const existingIndex = modules.items.findIndex((item) => (0, yaml_1.isMap)(item) && item.get('module') === MODULE_CLASS);
    if (!managedRooms) {
        if (existingIndex >= 0) {
            modules.items.splice(existingIndex, 1);
        }
    }
    else {
        const nextNode = doc.createNode({
            module: MODULE_CLASS,
            config: managedRooms.config,
        });
        if (existingIndex >= 0) {
            modules.items.splice(existingIndex, 1, nextNode);
        }
        else {
            modules.add(nextNode);
        }
    }
    fs.writeFileSync(HOMESERVER_YAML, String(doc), 'utf-8');
}
function verifyConfigured(config) {
    const content = fs.readFileSync(HOMESERVER_YAML, 'utf-8');
    const managedRooms = getEnabledManagedRooms(config);
    if (!managedRooms) {
        if (content.includes(MODULE_CLASS)) {
            throw new Error('managed-rooms-Modulblock steht in homeserver.yaml, obwohl das Modul aus ist');
        }
        return;
    }
    if (!content.includes(MODULE_CLASS)) {
        throw new Error('managed-rooms-Modulklasse fehlt in homeserver.yaml');
    }
    // Ohne exempt-Regel sperrt sich Prilog selbst aus: Raeume anlegen, Leute
    // eintragen, Aliase — alles laeuft ueber Dienstkonten. Lieber hier laut
    // scheitern als spaeter still.
    if (managedRooms.config.deny.length > 0 && managedRooms.config.exempt.length === 0) {
        throw new Error('managed-rooms verbietet Aktionen, aber es ist keine exempt-Regel gesetzt — ' +
            'das wuerde Prilogs eigene Dienstkonten aussperren');
    }
    for (const rule of managedRooms.config.exempt) {
        if (!content.includes(rule.match)) {
            throw new Error(`managed-rooms: exempt-Muster fehlt in homeserver.yaml: ${rule.match}`);
        }
    }
}
async function restartSynapseIfRequested(shouldRestart) {
    if (!shouldRestart)
        return;
    if (!fs.existsSync(compose_js_1.COMPOSE_PATH)) {
        throw new Error(`docker-compose.yml fehlt fuer managed-rooms-Restart: ${compose_js_1.COMPOSE_PATH}`);
    }
    await (0, safe_exec_js_1.dockerCompose)(compose_js_1.COMPOSE_PATH, ['up', '-d', 'synapse'], { timeout: 120_000 });
}
async function ensureManagedRoomsInstalled(config, options = {}) {
    const managedRooms = getEnabledManagedRooms(config);
    upsertModuleBlock(config);
    if (!managedRooms) {
        if (options.refreshCompose) {
            (0, compose_js_1.writeComposeFile)(config);
        }
        verifyConfigured(config);
        return { changed: false, message: 'managed-rooms ist fuer diesen Tenant nicht aktiviert' };
    }
    if (!managedRooms.packageUrl) {
        throw new Error('managed-rooms ist aktiviert, aber es ist keine packageUrl gesetzt');
    }
    await ensureArtifactExtracted(managedRooms.packageUrl);
    verifyExtracted();
    upsertModuleBlock(config);
    if (options.refreshCompose) {
        (0, compose_js_1.writeComposeFile)(config);
    }
    verifyConfigured(config);
    await restartSynapseIfRequested(Boolean(options.restartSynapse));
    logger_js_1.logger.info(`[managed-rooms] verboten: ${managedRooms.config.deny.join(', ') || 'nichts'} | ` +
        `Ausnahmen: ${managedRooms.config.exempt.length} | ` +
        `Direktnachrichten: ${managedRooms.config.allow_direct_messages ? 'erlaubt' : 'nein'}`);
    return {
        changed: true,
        message: `managed-rooms vorbereitet (${compose_js_1.MANAGED_ROOMS_HOST_DIR})`,
    };
}
function verifyManagedRoomsInstalled(config) {
    if (getEnabledManagedRooms(config)) {
        verifyExtracted();
    }
    verifyConfigured(config);
}
