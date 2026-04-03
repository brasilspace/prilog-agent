"use strict";
/**
 * provision/steps/04-start-containers.ts
 *
 * Step 4: Docker Compose starten und auf Health warten.
 *
 * Ablauf:
 *  1. docker compose pull (neuestes Image)
 *  2. docker compose up -d
 *  3. Polling bis Synapse-Container "healthy" → max 5 Minuten
 *
 * Idempotenz: docker compose up -d ist idempotent.
 *             Bereits laufende Container werden nicht neu erstellt.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.stepStartContainers = stepStartContainers;
exports.verifyStartContainers = verifyStartContainers;
const logger_js_1 = require("../../utils/logger.js");
const safe_exec_js_1 = require("../engine/safe-exec.js");
const COMPOSE_PATH = '/opt/prilog/docker-compose.yml';
const MAX_WAIT_MS = 5 * 60 * 1000; // 5 Minuten
const POLL_INTERVAL = 10_000; // 10 Sekunden
// ─── Container Health Check ───────────────────────────────────────────────────
async function getContainerHealth(containerName) {
    const result = await (0, safe_exec_js_1.safeExec)('docker', ['inspect', '--format={{.State.Health.Status}}', containerName], { ignoreExitCode: true, timeout: 5_000 });
    if (result.exitCode !== 0)
        return 'not_found';
    return result.stdout.trim().replace(/'/g, '') || 'unknown';
}
async function isContainerRunning(containerName) {
    const result = await (0, safe_exec_js_1.safeExec)('docker', ['inspect', '--format={{.State.Running}}', containerName], { ignoreExitCode: true, timeout: 5_000 });
    if (result.exitCode !== 0)
        return false;
    return result.stdout.trim().replace(/'/g, '') === 'true';
}
// ─── Wait for Synapse ─────────────────────────────────────────────────────────
async function waitForSynapse() {
    const start = Date.now();
    // Mögliche Container-Namen (docker compose generiert automatisch)
    const candidateNames = ['prilog-synapse-1', 'synapse'];
    logger_js_1.logger.info('[Step 4] Warte auf Synapse (max 5 Min)...');
    while (Date.now() - start < MAX_WAIT_MS) {
        for (const name of candidateNames) {
            const health = await getContainerHealth(name);
            if (health === 'healthy') {
                const elapsed = Math.round((Date.now() - start) / 1000);
                logger_js_1.logger.info(`[Step 4] Synapse healthy (${name}, nach ${elapsed}s)`);
                return;
            }
            if (health === 'not_found')
                continue;
            // running aber noch nicht healthy — warten
            logger_js_1.logger.info(`[Step 4] Synapse: ${name} → ${health} — warte...`);
        }
        await new Promise(resolve => setTimeout(resolve, POLL_INTERVAL));
    }
    // Timeout — Fehler mit Debug-Infos
    let debugInfo = '';
    try {
        const result = await (0, safe_exec_js_1.safeExec)('docker', ['ps', '--format', 'table {{.Names}}\t{{.Status}}'], { timeout: 10_000, ignoreExitCode: true });
        debugInfo = result.stdout;
    }
    catch { /* intentionally empty */ }
    throw new Error(`Synapse wurde nicht healthy nach ${MAX_WAIT_MS / 60000} Minuten.\n` +
        `Docker Status:\n${debugInfo}`);
}
// ─── Step ─────────────────────────────────────────────────────────────────────
async function stepStartContainers(_cfg) {
    // ── Idempotenz: bereits laufend? ──────────────────────────────────
    const alreadyRunning = (await isContainerRunning('prilog-synapse-1')) ||
        (await isContainerRunning('synapse'));
    if (alreadyRunning) {
        const health = (await getContainerHealth('prilog-synapse-1')) ||
            (await getContainerHealth('synapse'));
        if (health === 'healthy') {
            logger_js_1.logger.info('[Step 4] Container bereits laufend und healthy — überspringe');
            return;
        }
    }
    // ── Images pullen ─────────────────────────────────────────────────
    logger_js_1.logger.info('[Step 4] Pulle Docker Images...');
    await (0, safe_exec_js_1.dockerCompose)(COMPOSE_PATH, ['pull'], { timeout: 180_000 });
    logger_js_1.logger.info('[Step 4] Images gepullt');
    // ── Container starten ────────────────────────────────────────────
    logger_js_1.logger.info('[Step 4] Starte Container...');
    await (0, safe_exec_js_1.dockerCompose)(COMPOSE_PATH, ['up', '-d'], { timeout: 60_000 });
    logger_js_1.logger.info('[Step 4] Container gestartet');
    // ── Auf Synapse-Health warten ────────────────────────────────────
    await waitForSynapse();
}
async function verifyStartContainers(_cfg) {
    const candidates = ['prilog-synapse-1', 'synapse'];
    let healthy = false;
    for (const name of candidates) {
        if ((await getContainerHealth(name)) === 'healthy') {
            healthy = true;
            break;
        }
    }
    if (!healthy) {
        let debug = '';
        try {
            const result = await (0, safe_exec_js_1.safeExec)('docker', ['ps', '--format', '{{.Names}}: {{.Status}}'], { timeout: 5_000, ignoreExitCode: true });
            debug = result.stdout;
        }
        catch { /* intentionally empty */ }
        throw new Error(`Synapse nicht healthy nach Container-Start.\n${debug}`);
    }
}
