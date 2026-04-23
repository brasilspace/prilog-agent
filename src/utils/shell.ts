import { spawn } from 'child_process';
import { readFile, writeFile } from 'fs/promises';
import { CommandName } from '../types.js';
import { safeExec } from '../provision/engine/safe-exec.js';
import { deployWebClient } from '../provision/steps/06c-deploy-web-client.js';
import { ProvisionConfig } from '../provision/types.js';

// ─── Whitelist ────────────────────────────────────────────────────────────────
// Nur diese Befehle dürfen ausgeführt werden. Kein arbitrary shell exec.

interface CommandDef {
  command: string;
  args: (a?: Record<string, string | number | boolean>) => string[];
}

const COMMAND_MAP: Partial<Record<CommandName, CommandDef>> = {
  'synapse.restart':      { command: 'docker', args: () => ['compose', '-f', '/opt/prilog/docker-compose.yml', 'restart', 'synapse'] },
  'synapse.reload':       { command: 'docker', args: () => ['compose', '-f', '/opt/prilog/docker-compose.yml', 'kill', '-s', 'HUP', 'synapse'] },
  'synapse.status':       { command: 'docker', args: () => ['compose', '-f', '/opt/prilog/docker-compose.yml', 'ps', 'synapse'] },
  'docker.ps':            { command: 'docker', args: () => ['ps', '--format', 'table {{.Names}}\t{{.Status}}\t{{.Ports}}'] },
  'docker.logs':          { command: 'docker', args: (a) => ['logs', '--tail', String(a?.lines ?? 100), String(a?.container ?? 'synapse')] },
  'module.enable':        { command: 'docker', args: (a) => ['compose', '-f', `/opt/prilog/modules/${a?.module}/docker-compose.yml`, 'up', '-d'] },
  'module.disable':       { command: 'docker', args: (a) => ['compose', '-f', `/opt/prilog/modules/${a?.module}/docker-compose.yml`, 'down'] },
  'module.status':        { command: 'docker', args: () => ['ps', '--filter', 'label=prilog.module', '--format', '{{.Names}}\t{{.Status}}'] },
  'system.status':        { command: 'bash',   args: () => ['-c', 'uptime && free -m && df -h /mnt/prilog-data'] },
  'system.df':            { command: 'df',     args: () => ['-h', '/mnt/prilog-data'] },
  'agent.update':         { command: 'bash',   args: () => ['-c', 'cd /opt/prilog-agent && git pull && sudo systemctl restart prilog-agent'] },
  'agent.version':        { command: 'bash',   args: () => ['-c', 'cat /opt/prilog-agent/package.json | grep version'] },
};

export async function executeCommand(
  command: CommandName,
  args?: Record<string, string | number | boolean>
): Promise<{ success: boolean; output: string; duration: number }> {
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
      const homeserverYaml = await readFile(homeserverPath, 'utf8');
      const nextHomeserver = homeserverYaml.replace(
        /^max_upload_size:\s*\d+M\s*$/m,
        `max_upload_size: ${sizeMb}M`,
      );
      if (nextHomeserver === homeserverYaml && !/^max_upload_size:/m.test(homeserverYaml)) {
        return { success: false, output: 'max_upload_size nicht in homeserver.yaml gefunden', duration: Date.now() - start };
      }
      await writeFile(homeserverPath, nextHomeserver, 'utf8');

      // 2) nginx-conf: client_max_body_size <NUM>m (alle Vorkommen)
      const nginxPath = '/etc/nginx/sites-enabled/prilog';
      const nginxConf = await readFile(nginxPath, 'utf8');
      const nextNginx = nginxConf.replace(
        /client_max_body_size\s+\d+m\s*;/gi,
        `client_max_body_size ${sizeMb}m;`,
      );
      await writeFile(nginxPath, nextNginx, 'utf8');

      // 3) nginx testen + reloaden
      const nginxTest = await safeExec('nginx', ['-t'], { timeout: 10_000, ignoreExitCode: true });
      if (nginxTest.exitCode !== 0) {
        return { success: false, output: `nginx -t fehlgeschlagen: ${nginxTest.stderr}`, duration: Date.now() - start };
      }
      await safeExec('systemctl', ['reload', 'nginx'], { timeout: 10_000 });

      // 4) Synapse-Container restarten, damit die neue Grenze greift.
      //    Reload (SIGHUP) reicht nicht — Synapse liest max_upload_size nur beim Start.
      await safeExec('docker', ['restart', 'prilog-synapse-1'], { timeout: 60_000 });

      return {
        success: true,
        output: `Upload-Limit auf ${sizeMb}M gesetzt (homeserver.yaml + nginx), Synapse neu gestartet`,
        duration: Date.now() - start,
      };
    } catch (err: any) {
      return { success: false, output: err?.message ?? 'synapse.set_upload_size failed', duration: Date.now() - start };
    }
  }

  // ── system.health: umfassender Server-Wartungs-Check ───────────
  if (command === 'system.health') {
    try {
      const checks: Record<string, { status: string; message: string; value?: string | number }> = {};

      // 1. Disk-Nutzung
      try {
        const df = await safeExec('bash', ['-c', "df -h / | tail -1 | awk '{print $5, $4}'"], { timeout: 5_000 });
        const [usedPercent, available] = df.stdout.trim().split(' ');
        const pct = parseInt(usedPercent);
        checks.disk = {
          status: pct > 90 ? 'error' : pct > 80 ? 'warning' : 'ok',
          message: `${usedPercent} belegt, ${available} frei`,
          value: pct,
        };
      } catch { checks.disk = { status: 'error', message: 'df fehlgeschlagen' }; }

      // 2. SSL-Zertifikat Ablauf
      try {
        const ssl = await safeExec('bash', ['-c',
          "for cert in /etc/letsencrypt/live/*/cert.pem; do " +
          "domain=$(basename $(dirname $cert)); " +
          "expiry=$(openssl x509 -enddate -noout -in $cert 2>/dev/null | cut -d= -f2); " +
          "echo \"$domain|$expiry\"; done"
        ], { timeout: 10_000 });
        const certs = ssl.stdout.trim().split('\n').filter(Boolean).map(line => {
          const [domain, expiry] = line.split('|');
          const expiryDate = new Date(expiry);
          const daysLeft = Math.floor((expiryDate.getTime() - Date.now()) / 86400000);
          return { domain, daysLeft };
        });
        const minDays = Math.min(...certs.map(c => c.daysLeft));
        const expiringSoon = certs.filter(c => c.daysLeft < 14);
        checks.ssl = {
          status: minDays < 7 ? 'error' : minDays < 14 ? 'warning' : 'ok',
          message: expiringSoon.length > 0
            ? `${expiringSoon.map(c => `${c.domain}: ${c.daysLeft}d`).join(', ')}`
            : `Alle Zertifikate OK (min ${minDays} Tage)`,
          value: minDays,
        };
      } catch { checks.ssl = { status: 'warning', message: 'SSL-Check fehlgeschlagen' }; }

      // 3. OS-Updates ausstehend
      try {
        const updates = await safeExec('bash', ['-c',
          "apt list --upgradable 2>/dev/null | grep -c upgradable || echo 0"
        ], { timeout: 15_000 });
        const count = parseInt(updates.stdout.trim()) || 0;
        const security = await safeExec('bash', ['-c',
          "apt list --upgradable 2>/dev/null | grep -i security | wc -l || echo 0"
        ], { timeout: 15_000 });
        const secCount = parseInt(security.stdout.trim()) || 0;
        checks.osUpdates = {
          status: secCount > 0 ? 'warning' : count > 20 ? 'warning' : 'ok',
          message: `${count} Updates (${secCount} Sicherheit)`,
          value: count,
        };
      } catch { checks.osUpdates = { status: 'warning', message: 'apt check fehlgeschlagen' }; }

      // 4. Docker-Container Status
      try {
        const docker = await safeExec('docker', ['ps', '--format', '{{.Names}}|{{.Status}}'], { timeout: 10_000 });
        const containers = docker.stdout.trim().split('\n').filter(Boolean).map(line => {
          const [name, status] = line.split('|');
          return { name, status, healthy: status?.includes('Up') };
        });
        const unhealthy = containers.filter(c => !c.healthy);
        checks.docker = {
          status: unhealthy.length > 0 ? 'error' : 'ok',
          message: unhealthy.length > 0
            ? `${unhealthy.map(c => c.name).join(', ')} nicht gesund`
            : `${containers.length} Container laufen`,
          value: containers.length,
        };
      } catch { checks.docker = { status: 'warning', message: 'Docker check fehlgeschlagen' }; }

      // 5. Synapse-Version
      try {
        const ver = await safeExec('bash', ['-c',
          "curl -s http://127.0.0.1:8008/_synapse/admin/v1/server_version 2>/dev/null"
        ], { timeout: 10_000 });
        const parsed = JSON.parse(ver.stdout);
        checks.synapseVersion = {
          status: 'ok',
          message: `Synapse ${parsed.server_version}`,
          value: parsed.server_version,
        };
      } catch { checks.synapseVersion = { status: 'warning', message: 'Synapse-Version nicht abrufbar' }; }

      // 6. Backup-Alter (letztes Backup pruefen)
      try {
        const backup = await safeExec('bash', ['-c',
          "ls -t /mnt/prilog-data/backups/*.sql.gz /mnt/prilog-data/backups/*.tar.gz " +
          "/var/backups/prilog* 2>/dev/null | head -1 | xargs -I{} stat -c '%Y %n' {} 2>/dev/null || echo '0 none'"
        ], { timeout: 10_000 });
        const [tsStr, file] = backup.stdout.trim().split(' ', 2);
        const ts = parseInt(tsStr);
        if (ts === 0) {
          checks.backup = { status: 'error', message: 'Kein Backup gefunden' };
        } else {
          const ageHours = Math.floor((Date.now() / 1000 - ts) / 3600);
          checks.backup = {
            status: ageHours > 48 ? 'error' : ageHours > 24 ? 'warning' : 'ok',
            message: `Letztes Backup: ${ageHours}h alt (${file})`,
            value: ageHours,
          };
        }
      } catch { checks.backup = { status: 'warning', message: 'Backup-Check fehlgeschlagen' }; }

      // 7. Prilog-Versionen (Web-Client + Agent)
      try {
        const parts: string[] = [];
        // Web-Client Build-Hash aus index.html
        try {
          const wcHash = await safeExec('bash', ['-c',
            "grep -oP 'index-[a-zA-Z0-9_-]+\\.js' /var/www/prilog-web-client/index.html | head -1"
          ], { timeout: 5_000 });
          const hash = wcHash.stdout.trim().replace('index-', '').replace('.js', '');
          if (hash) parts.push(`Web-Client: ${hash}`);
        } catch { /* ignore */ }
        // Agent-Version aus package.json
        try {
          const agentVer = await safeExec('bash', ['-c',
            "cat /opt/prilog-agent/package.json /opt/prilog/agent/package.json 2>/dev/null | grep '\"version\"' | head -1 | grep -oP '\\d+\\.\\d+\\.\\d+'"
          ], { timeout: 5_000 });
          if (agentVer.stdout.trim()) parts.push(`Agent: v${agentVer.stdout.trim()}`);
        } catch { /* ignore */ }
        // Agent Git-Commit
        try {
          const agentGit = await safeExec('bash', ['-c',
            "cd /opt/prilog-agent 2>/dev/null || cd /opt/prilog/agent 2>/dev/null; git rev-parse --short HEAD 2>/dev/null"
          ], { timeout: 5_000 });
          if (agentGit.stdout.trim()) parts.push(`Commit: ${agentGit.stdout.trim()}`);
        } catch { /* ignore */ }

        checks.prilogVersion = {
          status: 'ok',
          message: parts.length > 0 ? parts.join(', ') : 'Version nicht ermittelbar',
        };
      } catch { checks.prilogVersion = { status: 'warning', message: 'Version-Check fehlgeschlagen' }; }

      // 8. IP-Adressen (oeffentlich + Tailscale)
      try {
        const parts: string[] = [];
        try {
          const pub = await safeExec('bash', ['-c',
            "curl -s --max-time 5 https://ifconfig.me 2>/dev/null || curl -s --max-time 5 https://api.ipify.org 2>/dev/null || echo '?'"
          ], { timeout: 10_000 });
          if (pub.stdout.trim()) parts.push(`Public: ${pub.stdout.trim()}`);
        } catch { /* ignore */ }
        try {
          const ts = await safeExec('bash', ['-c',
            "tailscale ip -4 2>/dev/null || echo '?'"
          ], { timeout: 5_000 });
          if (ts.stdout.trim() && ts.stdout.trim() !== '?') parts.push(`Tailscale: ${ts.stdout.trim()}`);
        } catch { /* ignore */ }
        checks.network = {
          status: 'ok',
          message: parts.length > 0 ? parts.join(', ') : 'IP nicht ermittelbar',
        };
      } catch { checks.network = { status: 'warning', message: 'Netzwerk-Check fehlgeschlagen' }; }

      const overall = Object.values(checks).some(c => c.status === 'error') ? 'error'
        : Object.values(checks).some(c => c.status === 'warning') ? 'warning' : 'ok';

      return {
        success: true,
        output: JSON.stringify({ overall, checks }),
        duration: Date.now() - start,
      };
    } catch (err: any) {
      return { success: false, output: err?.message ?? 'system.health failed', duration: Date.now() - start };
    }
  }

  // ── web_client.update: spezieller Handler ──────────────────────
  if (command === 'web_client.update') {
    try {
      const artifactUrl = args?.artifactUrl as string | undefined;
      if (!artifactUrl) {
        return { success: false, output: 'Missing required arg: artifactUrl', duration: Date.now() - start };
      }
      const sharedSecret = args?.sharedSecret as string | undefined;
      const partialConfig = {
        webClientArtifactUrl: artifactUrl,
        ...(sharedSecret ? { synapseModules: { connector: { config: { sharedSecret } } } } : {}),
      } as ProvisionConfig;
      await deployWebClient(partialConfig);
      await safeExec('systemctl', ['reload', 'nginx'], { timeout: 15_000 });
      return { success: true, output: 'Web client updated and nginx reloaded', duration: Date.now() - start };
    } catch (err: any) {
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
    const result = await safeExec(cmdDef.command, cmdArgs, { timeout: 30_000, ignoreExitCode: true });
    return {
      success: result.exitCode === 0,
      output: (result.stdout + result.stderr).trim(),
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
  const cmds: Record<string, [string, string[]]> = {
    synapse: ['docker', ['logs', '-f', '--tail', '50', 'synapse']],
    nginx:   ['tail',   ['-f', '/var/log/nginx/access.log']],
    agent:   ['journalctl', ['-u', 'prilog-agent', '-f', '-n', '50']],
  };

  const [cmd, cmdArgs] = cmds[source];
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
