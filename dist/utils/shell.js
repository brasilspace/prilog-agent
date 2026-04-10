"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.executeCommand = executeCommand;
exports.spawnLogStream = spawnLogStream;
const child_process_1 = require("child_process");
const promises_1 = require("fs/promises");
const safe_exec_js_1 = require("../provision/engine/safe-exec.js");
const _06c_deploy_web_client_js_1 = require("../provision/steps/06c-deploy-web-client.js");
const COMMAND_MAP = {
    'synapse.restart': { command: 'docker', args: () => ['compose', '-f', '/opt/prilog/docker-compose.yml', 'restart', 'synapse'] },
    'synapse.reload': { command: 'docker', args: () => ['compose', '-f', '/opt/prilog/docker-compose.yml', 'kill', '-s', 'HUP', 'synapse'] },
    'synapse.status': { command: 'docker', args: () => ['compose', '-f', '/opt/prilog/docker-compose.yml', 'ps', 'synapse'] },
    'docker.ps': { command: 'docker', args: () => ['ps', '--format', 'table {{.Names}}\t{{.Status}}\t{{.Ports}}'] },
    'docker.logs': { command: 'docker', args: (a) => ['logs', '--tail', String(a?.lines ?? 100), String(a?.container ?? 'synapse')] },
    'module.enable': { command: 'docker', args: (a) => ['compose', '-f', `/opt/prilog/modules/${a?.module}/docker-compose.yml`, 'up', '-d'] },
    'module.disable': { command: 'docker', args: (a) => ['compose', '-f', `/opt/prilog/modules/${a?.module}/docker-compose.yml`, 'down'] },
    'module.status': { command: 'docker', args: () => ['ps', '--filter', 'label=prilog.module', '--format', '{{.Names}}\t{{.Status}}'] },
    'system.status': { command: 'bash', args: () => ['-c', 'uptime && free -m && df -h /mnt/prilog-data'] },
    'system.df': { command: 'df', args: () => ['-h', '/mnt/prilog-data'] },
    'agent.update': { command: 'bash', args: () => ['-c', 'cd /opt/prilog-agent && git pull && sudo systemctl restart prilog-agent'] },
    'agent.version': { command: 'bash', args: () => ['-c', 'cat /opt/prilog-agent/package.json | grep version'] },
};
async function executeCommand(command, args) {
    const start = Date.now();
    // ── synapse.set_upload_size: Upload-Limit in Synapse + nginx ────
    // Akzeptiert args.sizeMb (Integer, z.B. 200). Setzt max_upload_size
    // in /mnt/prilog-data/synapse/homeserver.yaml und client_max_body_size
    // in /etc/nginx/sites-enabled/prilog, startet Synapse und reloaded nginx.
    // Wir editieren die yaml per RegEx statt mit einem YAML-Parser, weil
    // die Zeile genau einmal vorkommt und das Format fest ist — so muessen
    // wir keine Abhaengigkeit ziehen.
    if (command === 'synapse.set_upload_size') {
        try {
            const sizeMb = Number(args?.sizeMb);
            if (!Number.isInteger(sizeMb) || sizeMb < 10 || sizeMb > 2000) {
                return { success: false, output: `Ungueltige sizeMb: ${args?.sizeMb} (erlaubt 10..2000)`, duration: Date.now() - start };
            }
            // 1) homeserver.yaml: max_upload_size: <NUM>M
            const homeserverPath = '/mnt/prilog-data/synapse/homeserver.yaml';
            const homeserverYaml = await (0, promises_1.readFile)(homeserverPath, 'utf8');
            const nextHomeserver = homeserverYaml.replace(/^max_upload_size:\s*\d+M\s*$/m, `max_upload_size: ${sizeMb}M`);
            if (nextHomeserver === homeserverYaml && !/^max_upload_size:/m.test(homeserverYaml)) {
                return { success: false, output: 'max_upload_size nicht in homeserver.yaml gefunden', duration: Date.now() - start };
            }
            await (0, promises_1.writeFile)(homeserverPath, nextHomeserver, 'utf8');
            // 2) nginx-conf: client_max_body_size <NUM>m (alle Vorkommen)
            const nginxPath = '/etc/nginx/sites-enabled/prilog';
            const nginxConf = await (0, promises_1.readFile)(nginxPath, 'utf8');
            const nextNginx = nginxConf.replace(/client_max_body_size\s+\d+m\s*;/gi, `client_max_body_size ${sizeMb}m;`);
            await (0, promises_1.writeFile)(nginxPath, nextNginx, 'utf8');
            // 3) nginx testen + reloaden
            const nginxTest = await (0, safe_exec_js_1.safeExec)('nginx', ['-t'], { timeout: 10_000, ignoreExitCode: true });
            if (nginxTest.exitCode !== 0) {
                return { success: false, output: `nginx -t fehlgeschlagen: ${nginxTest.stderr}`, duration: Date.now() - start };
            }
            await (0, safe_exec_js_1.safeExec)('systemctl', ['reload', 'nginx'], { timeout: 10_000 });
            // 4) Synapse-Container restarten, damit die neue Grenze greift.
            //    Reload (SIGHUP) reicht nicht — Synapse liest max_upload_size nur beim Start.
            await (0, safe_exec_js_1.safeExec)('docker', ['restart', 'prilog-synapse-1'], { timeout: 60_000 });
            return {
                success: true,
                output: `Upload-Limit auf ${sizeMb}M gesetzt (homeserver.yaml + nginx), Synapse neu gestartet`,
                duration: Date.now() - start,
            };
        }
        catch (err) {
            return { success: false, output: err?.message ?? 'synapse.set_upload_size failed', duration: Date.now() - start };
        }
    }
    // ── web_client.update: spezieller Handler ──────────────────────
    if (command === 'web_client.update') {
        try {
            const artifactUrl = args?.artifactUrl;
            if (!artifactUrl) {
                return { success: false, output: 'Missing required arg: artifactUrl', duration: Date.now() - start };
            }
            const sharedSecret = args?.sharedSecret;
            const partialConfig = {
                webClientArtifactUrl: artifactUrl,
                ...(sharedSecret ? { synapseModules: { connector: { config: { sharedSecret } } } } : {}),
            };
            await (0, _06c_deploy_web_client_js_1.deployWebClient)(partialConfig);
            await (0, safe_exec_js_1.safeExec)('systemctl', ['reload', 'nginx'], { timeout: 15_000 });
            return { success: true, output: 'Web client updated and nginx reloaded', duration: Date.now() - start };
        }
        catch (err) {
            return { success: false, output: err?.message ?? 'web_client.update failed', duration: Date.now() - start };
        }
    }
    const cmdDef = COMMAND_MAP[command];
    if (!cmdDef) {
        return { success: false, output: `Unknown command: ${command}`, duration: 0 };
    }
    const cmdArgs = cmdDef.args(args);
    // Skip empty commands (like logs.stream.start/stop handled separately)
    if (!cmdDef.command) {
        return { success: true, output: 'OK', duration: 0 };
    }
    try {
        const result = await (0, safe_exec_js_1.safeExec)(cmdDef.command, cmdArgs, { timeout: 30_000, ignoreExitCode: true });
        return {
            success: result.exitCode === 0,
            output: (result.stdout + result.stderr).trim(),
            duration: Date.now() - start,
        };
    }
    catch (err) {
        return {
            success: false,
            output: err?.message ?? 'Command failed',
            duration: Date.now() - start,
        };
    }
}
// ─── Log Streaming via spawn ──────────────────────────────────────────────────
function spawnLogStream(source, onLine, onClose) {
    const cmds = {
        synapse: ['docker', ['logs', '-f', '--tail', '50', 'synapse']],
        nginx: ['tail', ['-f', '/var/log/nginx/access.log']],
        agent: ['journalctl', ['-u', 'prilog-agent', '-f', '-n', '50']],
    };
    const [cmd, cmdArgs] = cmds[source];
    const child = (0, child_process_1.spawn)(cmd, cmdArgs, { stdio: ['ignore', 'pipe', 'pipe'] });
    const handle = (data) => {
        data.toString().split('\n').filter(Boolean).forEach(onLine);
    };
    child.stdout.on('data', handle);
    child.stderr.on('data', handle);
    child.on('close', onClose);
    // Gibt eine stop-Funktion zurück
    return () => child.kill('SIGTERM');
}
