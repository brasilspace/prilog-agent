"use strict";
/**
 * provision/steps/03-write-compose.ts
 *
 * Step 3: docker-compose.yml für Synapse + PostgreSQL schreiben.
 *
 * Idempotenz: Immer überschreiben — gleiche Config ergibt gleiche Datei.
 *             docker compose up -d ist ebenfalls idempotent.
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
exports.stepWriteCompose = stepWriteCompose;
exports.verifyWriteCompose = verifyWriteCompose;
const fs = __importStar(require("fs"));
const logger_js_1 = require("../../utils/logger.js");
const compose_js_1 = require("../compose.js");
const safe_exec_js_1 = require("../engine/safe-exec.js");
// ─── Step ─────────────────────────────────────────────────────────────────────
async function stepWriteCompose(cfg) {
    (0, compose_js_1.writeComposeFile)(cfg);
    logger_js_1.logger.info(`[Step 3] docker-compose.yml geschrieben: ${compose_js_1.COMPOSE_PATH}`);
}
async function verifyWriteCompose(_cfg) {
    if (!fs.existsSync(`${compose_js_1.COMPOSE_DIR}/docker-compose.yml`)) {
        throw new Error('docker-compose.yml fehlt nach Write-Compose');
    }
    // YAML-Syntax prüfen
    const result = await (0, safe_exec_js_1.safeExec)('docker', ['compose', '-f', `${compose_js_1.COMPOSE_DIR}/docker-compose.yml`, 'config', '--quiet'], { ignoreExitCode: true, timeout: 10_000 });
    if (result.exitCode !== 0) {
        throw new Error('docker-compose.yml ist ungültig (docker compose config fehlgeschlagen)');
    }
}
