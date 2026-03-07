import { exec, spawn } from 'child_process';
import { promisify } from 'util';
import { CommandName } from '../types.js';

const execAsync = promisify(exec);

// ─── Whitelist ────────────────────────────────────────────────────────────────
// Nur diese Befehle dürfen ausgeführt werden. Kein arbitrary shell exec.

const COMMAND_MAP: Partial<Record<CommandName, (args?: Record<string, string | number | boolean>) => string>> = {
  'synapse.restart':      () => 'docker compose -f /opt/synapse/docker-compose.yml restart synapse',
  'synapse.reload':       () => 'docker compose -f /opt/synapse/docker-compose.yml kill -s HUP synapse',
  'synapse.status':       () => 'docker compose -f /opt/synapse/docker-compose.yml ps synapse',
  'docker.ps':            () => 'docker ps --format "table {{.Names}}\\t{{.Status}}\\t{{.Ports}}"',
  'docker.logs':          (a) => `docker logs --tail ${a?.lines ?? 100} ${a?.container ?? 'synapse'}`,
  'module.enable':        (a) => `docker compose -f /opt/synapse/modules/${a?.module}/docker-compose.yml up -d`,
  'module.disable':       (a) => `docker compose -f /opt/synapse/modules/${a?.module}/docker-compose.yml down`,
  'module.status':        () => 'docker ps --filter "label=prilog.module" --format "{{.Names}}\\t{{.Status}}"',
  'logs.stream.start':    () => '',  // handled separately via spawn
  'logs.stream.stop':     () => '',  // handled separately
  'system.status':        () => 'uptime && free -m && df -h /opt/synapse',
  'system.df':            () => 'df -h /opt/synapse/data',
  'agent.update':         () => 'cd /opt/prilog-agent && git pull && npm run build && sudo systemctl restart prilog-agent',
  'agent.version':        () => 'cat /opt/prilog-agent/package.json | grep version',
};

export async function executeCommand(
  command: CommandName,
  args?: Record<string, string | number | boolean>
): Promise<{ success: boolean; output: string; duration: number }> {
  const start = Date.now();

  const cmdFn = COMMAND_MAP[command];
  if (!cmdFn) {
    return { success: false, output: `Unknown command: ${command}`, duration: 0 };
  }

  const cmdStr = cmdFn(args);
  if (!cmdStr) {
    return { success: true, output: 'OK', duration: 0 };
  }

  try {
    const { stdout, stderr } = await execAsync(cmdStr, { timeout: 30_000 });
    return {
      success: true,
      output: (stdout + stderr).trim(),
      duration: Date.now() - start,
    };
  } catch (err: any) {
    return {
      success: false,
      output: err?.message ?? 'Command failed',
      duration: Date.now() - start,
    };
  }
}

// ─── Log Streaming via spawn ──────────────────────────────────────────────────

export function spawnLogStream(
  source: 'synapse' | 'nginx' | 'agent',
  onLine: (line: string) => void,
  onClose: () => void
): () => void {
  const cmds: Record<string, string[]> = {
    synapse: ['docker', ['logs', '-f', '--tail', '50', 'synapse']],
    nginx:   ['tail',   ['-f', '/var/log/nginx/access.log']],
    agent:   ['journalctl', ['-u', 'prilog-agent', '-f', '-n', '50']],
  } as any;

  const [cmd, cmdArgs] = cmds[source] as [string, string[]];
  const child = spawn(cmd, cmdArgs, { stdio: ['ignore', 'pipe', 'pipe'] });

  const handle = (data: Buffer) => {
    data.toString().split('\n').filter(Boolean).forEach(onLine);
  };

  child.stdout.on('data', handle);
  child.stderr.on('data', handle);
  child.on('close', onClose);

  // Gibt eine stop-Funktion zurück
  return () => child.kill('SIGTERM');
}
