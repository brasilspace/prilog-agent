import * as os from 'os';
import { execSync } from 'child_process';
import { config } from '../config.js';
import { MetricsPayload } from '../types.js';
import { logger } from '../utils/logger.js';

// ─── CPU ──────────────────────────────────────────────────────────────────────

function getCpuUsage(): Promise<number> {
  return new Promise((resolve) => {
    const start = os.cpus().map(c => c.times);
    setTimeout(() => {
      const end = os.cpus().map(c => c.times);
      let idle = 0, total = 0;
      end.forEach((e, i) => {
        const s = start[i];
        const idleDiff  = e.idle  - s.idle;
        const totalDiff = Object.values(e).reduce((a, b) => a + b, 0)
                        - Object.values(s).reduce((a, b) => a + b, 0);
        idle  += idleDiff;
        total += totalDiff;
      });
      resolve(Math.round((1 - idle / total) * 100));
    }, 500);
  });
}

// ─── RAM ──────────────────────────────────────────────────────────────────────

function getRamMetrics(): { ramTotal: number; ramUsed: number; ramPct: number } {
  const total = os.totalmem();
  const free  = os.freemem();
  const used  = total - free;
  return {
    ramTotal: Math.round(total / 1024 / 1024),
    ramUsed:  Math.round(used  / 1024 / 1024),
    ramPct:   Math.round((used / total) * 100),
  };
}

// ─── Disk ─────────────────────────────────────────────────────────────────────

function getDiskMetrics(): { diskTotal: number; diskUsed: number; diskPct: number } {
  const paths = ['/opt/synapse/data', '/mnt/synapse-data', '/'];
  for (const p of paths) {
    try {
      const out = execSync(`df -k ${p} --output=size,used,pcent | tail -1`).toString().trim();
      const [sizeKb, usedKb, pctStr] = out.split(/\s+/);
      return {
        diskTotal: Math.round(parseInt(sizeKb) / 1024 / 1024),
        diskUsed:  Math.round(parseInt(usedKb) / 1024 / 1024),
        diskPct:   parseInt(pctStr),
      };
    } catch {
      continue;
    }
  }
  return { diskTotal: 0, diskUsed: 0, diskPct: 0 };
}

// ─── Synapse User Count ───────────────────────────────────────────────────────

async function getSynapseMetrics(): Promise<{ userCount: number; up: boolean }> {
  try {
    const res = await fetch(`${config.synapseAdminUrl}/_synapse/admin/v2/users?limit=1`, {
      signal: AbortSignal.timeout(3000),
    });
    if (!res.ok) return { userCount: 0, up: false };
    const data = await res.json() as { total: number };
    return { userCount: data.total ?? 0, up: true };
  } catch {
    return { userCount: 0, up: false };
  }
}

// ─── Volume Usage ─────────────────────────────────────────────────────────────

function getVolumeUsage(): number {
  const paths = ['/mnt/synapse-data', '/opt/synapse/data', '/'];
  for (const p of paths) {
    try {
      const out = execSync(`df -k ${p} --output=pcent | tail -1`).toString().trim();
      return parseInt(out);
    } catch {
      continue;
    }
  }
  return 0;
}

// ─── Public ───────────────────────────────────────────────────────────────────

export async function collectMetrics(): Promise<MetricsPayload> {
  const [cpu, synapse] = await Promise.all([getCpuUsage(), getSynapseMetrics()]);
  const ram  = getRamMetrics();
  const disk = getDiskMetrics();
  const vol  = getVolumeUsage();

  logger.debug('Metrics collected', { cpu, ram: ram.ramPct, disk: disk.diskPct, users: synapse.userCount });

  return {
    cpu,
    ram:         ram.ramPct,
    ramTotal:    ram.ramTotal,
    ramUsed:     ram.ramUsed,
    disk:        disk.diskPct,
    diskTotal:   disk.diskTotal,
    diskUsed:    disk.diskUsed,
    volumeUsage: vol,
    matrixUsers: synapse.userCount,
    synapseUp:   synapse.up,
    loadAvg:     os.loadavg() as [number, number, number],
    uptimeSeconds: os.uptime(),
  };
}
