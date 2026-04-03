"use strict";
/**
 * provision/steps/06c-deploy-web-client.ts
 *
 * Step 06c: Deploy Prilog Web Client
 * Downloads the latest web-client build and extracts to /var/www/prilog-web-client/
 *
 * Idempotenz: Ueberschreibt vorhandene Dateien — gleicher Inhalt bei gleichem Artifact.
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
exports.deployWebClient = deployWebClient;
exports.stepDeployWebClient = stepDeployWebClient;
exports.verifyDeployWebClient = verifyDeployWebClient;
const fs = __importStar(require("fs"));
const logger_js_1 = require("../../utils/logger.js");
const safe_exec_js_1 = require("../engine/safe-exec.js");
const WEB_CLIENT_DIR = '/var/www/prilog-web-client';
const ARTIFACT_TMP = '/tmp/prilog-web-client.tar.gz';
// ─── Download & Extract ──────────────────────────────────────────────────────
async function deployWebClient(config) {
    const artifactUrl = config.webClientArtifactUrl;
    if (!artifactUrl) {
        throw new Error('webClientArtifactUrl nicht in ProvisionConfig gesetzt');
    }
    // ── Zielverzeichnis anlegen ──────────────────────────────────────
    await (0, safe_exec_js_1.safeExec)('mkdir', ['-p', WEB_CLIENT_DIR], { timeout: 5_000 });
    logger_js_1.logger.info('[Step 06c] Verzeichnis erstellt: ' + WEB_CLIENT_DIR);
    // ── Artifact herunterladen ───────────────────────────────────────
    logger_js_1.logger.info('[Step 06c] Lade Web-Client Artifact herunter...');
    const curlArgs = ['-fSL', '--max-time', '120', '-o', ARTIFACT_TMP];
    // Shared Secret für authentifizierten Download über Backend
    const sharedSecret = config.synapseModules?.connector?.config?.sharedSecret;
    if (sharedSecret) {
        curlArgs.push('-H', `x-matrix-connector-secret: ${sharedSecret}`);
    }
    curlArgs.push(artifactUrl);
    await (0, safe_exec_js_1.safeExec)('curl', curlArgs, { timeout: 130_000 });
    logger_js_1.logger.info('[Step 06c] Artifact heruntergeladen');
    // ── Entpacken (dist/ Inhalt nach /var/www/prilog-web-client/) ───
    await (0, safe_exec_js_1.safeExec)('tar', [
        '-xzf', ARTIFACT_TMP,
        '-C', WEB_CLIENT_DIR,
        '--strip-components=1',
    ], { timeout: 30_000 });
    logger_js_1.logger.info('[Step 06c] Artifact entpackt');
    // ── Aufräumen ────────────────────────────────────────────────────
    await (0, safe_exec_js_1.safeExec)('rm', ['-f', ARTIFACT_TMP], { timeout: 5_000 });
    // ── Berechtigungen setzen ────────────────────────────────────────
    await (0, safe_exec_js_1.safeExec)('chown', ['-R', 'www-data:www-data', WEB_CLIENT_DIR], { timeout: 10_000 });
    logger_js_1.logger.info('[Step 06c] Berechtigungen gesetzt');
}
// ─── Step ────────────────────────────────────────────────────────────────────
async function stepDeployWebClient(config) {
    logger_js_1.logger.info('[Step 06c] Deploye Prilog Web Client...');
    await deployWebClient(config);
    logger_js_1.logger.info('[Step 06c] Web Client deployed');
}
// ─── Verify ──────────────────────────────────────────────────────────────────
async function verifyDeployWebClient(_config) {
    const indexPath = `${WEB_CLIENT_DIR}/index.html`;
    if (!fs.existsSync(indexPath)) {
        throw new Error(`Web Client Verifikation fehlgeschlagen: ${indexPath} nicht gefunden`);
    }
    logger_js_1.logger.info('[Step 06c] Verifikation OK — index.html vorhanden');
}
