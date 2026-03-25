/**
 * Safe command execution using spawn() instead of exec().
 * No shell interpretation — prevents injection attacks.
 */
import { spawn } from 'child_process';
import { logger } from '../../utils/logger.js';

export interface SafeExecOptions {
  timeout?: number;
  env?: Record<string, string>;
  cwd?: string;
  /** If true, don't throw on non-zero exit code */
  ignoreExitCode?: boolean;
}

export interface SafeExecResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

const SENSITIVE_PREFIXES = [
  '--authkey=',
  '--password=',
  '--token=',
  '--secret=',
  'Authorization:',
  'Bearer ',
];

/** Mask sensitive values in log output */
function maskSensitiveArgs(args: string[]): string[] {
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

export function safeExec(
  command: string,
  args: string[],
  options?: SafeExecOptions,
): Promise<SafeExecResult> {
  return new Promise((resolve, reject) => {
    const maskedArgs = maskSensitiveArgs(args);
    logger.info(`[safe-exec] ${command} ${maskedArgs.join(' ')}`);

    const child = spawn(command, args, {
      shell: false,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: options?.env ? { ...process.env, ...options.env } : undefined,
      cwd: options?.cwd,
    });

    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];

    child.stdout.on('data', (chunk: Buffer) => stdoutChunks.push(chunk));
    child.stderr.on('data', (chunk: Buffer) => stderrChunks.push(chunk));

    let killed = false;
    let timer: ReturnType<typeof setTimeout> | undefined;

    if (options?.timeout && options.timeout > 0) {
      timer = setTimeout(() => {
        killed = true;
        child.kill('SIGKILL');
      }, options.timeout);
    }

    child.on('error', (err) => {
      if (timer) clearTimeout(timer);
      logger.error(`[safe-exec] spawn error: ${err.message}`);
      reject(new Error(`Failed to spawn "${command}": ${err.message}`));
    });

    child.on('close', (code) => {
      if (timer) clearTimeout(timer);

      const stdout = Buffer.concat(stdoutChunks).toString('utf-8');
      const stderr = Buffer.concat(stderrChunks).toString('utf-8');
      const exitCode = code ?? 1;

      if (killed) {
        const msg = `Command "${command}" timed out after ${options!.timeout}ms`;
        logger.error(`[safe-exec] ${msg}`);
        reject(new Error(msg));
        return;
      }

      if (exitCode !== 0 && !options?.ignoreExitCode) {
        const errOutput = stderr.trim() || stdout.trim();
        const msg = `Command "${command}" exited with code ${exitCode}: ${errOutput.slice(0, 500)}`;
        logger.error(`[safe-exec] ${msg}`);
        reject(new Error(msg));
        return;
      }

      logger.debug(`[safe-exec] ${command} exited with code ${exitCode}`);
      resolve({ stdout, stderr, exitCode });
    });
  });
}

/** Helper for docker exec commands */
export function dockerExec(
  containerName: string,
  command: string[],
  options?: SafeExecOptions,
): Promise<SafeExecResult> {
  return safeExec('docker', ['exec', containerName, ...command], options);
}

/** Helper for docker compose commands */
export function dockerCompose(
  composeFile: string,
  subcommand: string[],
  options?: SafeExecOptions,
): Promise<SafeExecResult> {
  return safeExec('docker', ['compose', '-f', composeFile, ...subcommand], options);
}
