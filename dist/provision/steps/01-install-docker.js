"use strict";
/**
 * provision/steps/01-install-docker.ts
 *
 * Docker CE + Compose Plugin installieren.
 * Idempotent: prüft ob docker bereits installiert ist.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.stepInstallDocker = stepInstallDocker;
exports.verifyInstallDocker = verifyInstallDocker;
const logger_js_1 = require("../../utils/logger.js");
const safe_exec_js_1 = require("../engine/safe-exec.js");
async function isDockerInstalled() {
    const result = await (0, safe_exec_js_1.safeExec)('docker', ['--version'], { ignoreExitCode: true });
    return result.exitCode === 0;
}
async function stepInstallDocker(_cfg) {
    if (await isDockerInstalled()) {
        logger_js_1.logger.info('[Step 01] Docker bereits installiert — überspringe');
        return;
    }
    logger_js_1.logger.info('[Step 01] Installiere Docker...');
    await (0, safe_exec_js_1.safeExec)('apt-get', ['install', '-y', 'apt-transport-https', 'ca-certificates', 'curl', 'gnupg', 'lsb-release'], { timeout: 120_000 });
    // Shell pipe for GPG key — hardcoded command, no user input
    await (0, safe_exec_js_1.safeExec)('bash', ['-c', 'curl -fsSL https://download.docker.com/linux/ubuntu/gpg | gpg --dearmor -o /usr/share/keyrings/docker-archive-keyring.gpg'], { timeout: 30_000 });
    // Add Docker repo — needs shell for $(lsb_release -cs)
    await (0, safe_exec_js_1.safeExec)('bash', ['-c', 'echo "deb [arch=amd64 signed-by=/usr/share/keyrings/docker-archive-keyring.gpg] https://download.docker.com/linux/ubuntu $(lsb_release -cs) stable" > /etc/apt/sources.list.d/docker.list'], { timeout: 10_000 });
    await (0, safe_exec_js_1.safeExec)('apt-get', ['update', '-qq'], { timeout: 60_000 });
    await (0, safe_exec_js_1.safeExec)('apt-get', ['install', '-y', 'docker-ce', 'docker-ce-cli', 'containerd.io', 'docker-compose-plugin'], { timeout: 180_000 });
    await (0, safe_exec_js_1.safeExec)('systemctl', ['enable', 'docker'], { timeout: 30_000 });
    await (0, safe_exec_js_1.safeExec)('systemctl', ['start', 'docker'], { timeout: 30_000 });
    logger_js_1.logger.info('[Step 01] Docker installiert und gestartet');
}
async function verifyInstallDocker(_cfg) {
    const dockerResult = await (0, safe_exec_js_1.safeExec)('docker', ['--version'], { ignoreExitCode: true });
    if (dockerResult.exitCode !== 0) {
        throw new Error('Docker oder Docker Compose nicht verfügbar nach Installation');
    }
    const composeResult = await (0, safe_exec_js_1.safeExec)('docker', ['compose', 'version'], { ignoreExitCode: true });
    if (composeResult.exitCode !== 0) {
        throw new Error('Docker oder Docker Compose nicht verfügbar nach Installation');
    }
    const activeResult = await (0, safe_exec_js_1.safeExec)('systemctl', ['is-active', 'docker'], { ignoreExitCode: true });
    if (activeResult.exitCode !== 0) {
        throw new Error('Docker-Dienst läuft nicht (systemctl is-active docker fehlgeschlagen)');
    }
}
