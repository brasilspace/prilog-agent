"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.safeExec = safeExec;
exports.dockerExec = dockerExec;
exports.dockerCompose = dockerCompose;
/**
 * Safe command execution using spawn() instead of exec().
 * No shell interpretation — prevents injection attacks.
 */
const child_process_1 = require("child_process");
const logger_js_1 = require("../../utils/logger.js");
const SENSITIVE_PREFIXES = [
    '--authkey=',
    '--password=',
    '--token=',
    '--secret=',
    'Authorization:',
    'Bearer ',
];
/** Mask sensitive values in log output */
function maskSensitiveArgs(args) {
    return args.map(arg => {
        for (const prefix of SENSITIVE_PREFIXES) {
            if (arg.startsWith(prefix)) {
                return `${prefix}****`;
            }
            // Handle --key value patterns with = separator
            const eqIdx = arg.indexOf('=');
            if (eqIdx !== -1) {
                const key = arg.slice(0, eqIdx + 1);
                if (SENSITIVE_PREFIXES.some(p => key.toLowerCase().startsWith(p.toLowerCase()))) {
                    return `${key}****`;
                }
            }
        }
        return arg;
    });
}
function safeExec(command, args, options) {
    return new Promise((resolve, reject) => {
        const maskedArgs = maskSensitiveArgs(args);
        logger_js_1.logger.info(`[safe-exec] ${command} ${maskedArgs.join(' ')}`);
        const child = (0, child_process_1.spawn)(command, args, {
            shell: false,
            stdio: ['ignore', 'pipe', 'pipe'],
            env: options?.env ? { ...process.env, ...options.env } : undefined,
            cwd: options?.cwd,
        });
        const stdoutChunks = [];
        const stderrChunks = [];
        child.stdout.on('data', (chunk) => stdoutChunks.push(chunk));
        child.stderr.on('data', (chunk) => stderrChunks.push(chunk));
        let killed = false;
        let timer;
        if (options?.timeout && options.timeout > 0) {
            timer = setTimeout(() => {
                killed = true;
                child.kill('SIGKILL');
            }, options.timeout);
        }
        child.on('error', (err) => {
            if (timer)
                clearTimeout(timer);
            // ENOENT = binary not found — treat like exit code 127 if ignoreExitCode
            if (options?.ignoreExitCode && err.code === 'ENOENT') {
                logger_js_1.logger.debug(`[safe-exec] ${command} not found (ENOENT) — treated as exitCode 127`);
                resolve({ stdout: '', stderr: err.message, exitCode: 127 });
                return;
            }
            logger_js_1.logger.error(`[safe-exec] spawn error: ${err.message}`);
            reject(new Error(`Failed to spawn "${command}": ${err.message}`));
        });
        child.on('close', (code) => {
            if (timer)
                clearTimeout(timer);
            const stdout = Buffer.concat(stdoutChunks).toString('utf-8');
            const stderr = Buffer.concat(stderrChunks).toString('utf-8');
            const exitCode = code ?? 1;
            if (killed) {
                const msg = `Command "${command}" timed out after ${options.timeout}ms`;
                logger_js_1.logger.error(`[safe-exec] ${msg}`);
                reject(new Error(msg));
                return;
            }
            if (exitCode !== 0 && !options?.ignoreExitCode) {
                const errOutput = stderr.trim() || stdout.trim();
                const msg = `Command "${command}" exited with code ${exitCode}: ${errOutput.slice(0, 500)}`;
                logger_js_1.logger.error(`[safe-exec] ${msg}`);
                reject(new Error(msg));
                return;
            }
            logger_js_1.logger.debug(`[safe-exec] ${command} exited with code ${exitCode}`);
            resolve({ stdout, stderr, exitCode });
        });
    });
}
/** Helper for docker exec commands */
function dockerExec(containerName, command, options) {
    return safeExec('docker', ['exec', containerName, ...command], options);
}
/** Helper for docker compose commands */
function dockerCompose(composeFile, subcommand, options) {
    return safeExec('docker', ['compose', '-f', composeFile, ...subcommand], options);
}
