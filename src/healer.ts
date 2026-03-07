import { execSync, exec } from 'child_process';
import { promisify } from 'util';
import { logger } from './utils/logger.js';

const execAsync = promisify(exec);

// ─── Types ────────────────────────────────────────────────────────────────────

export type HealEventType =
  | 'synapse.down'        // Synapse Container war down → neugestartet
  | 'postgres.down'       // PostgreSQL Container war down → neugestartet
  | 'nginx.down'          // Nginx war down → neugestartet
  | 'disk.critical'       // Disk > 90% → Warnung
  | 'ram.critical'        // RAM > 95% → Synapse reload
  | 'compose.missing'     // docker-compose.yml fehlt → nichts tun, melden
  | 'docker.unhealthy'    // Container unhealthy → restart
  | 'heal.ok';            // Alles gesund

export interface HealEvent {
  type:      HealEventType;
  message:   string;
  healed:    boolean;   // Wurde aktiv repariert?
  ts:        Date;
  details?:  string;
}

// ─── Compose Path ─────────────────────────────────────────────────────────────

const COMPOSE_PATHS = [
  '/opt/prilog/docker-compose.yml',
  '/opt/synapse/docker-compose.yml',
];

function getComposePath(): string | null {
  for (const p of COMPOSE_PATHS) {
    try {
      execSync(`test -f ${p}`);
      return p;
    } catch {}
  }
  return null;
}

// ─── Checks ───────────────────────────────────────────────────────────────────

async function isContainerRunning(name: string): Promise<boolean> {
  try {
    const out = execSync(`docker inspect --format='{{.State.Running}}' ${name} 2>/dev/null`).toString().trim();
    return out === 'true';
  } catch {
    return false;
  }
}

async function isContainerHealthy(name: string): Promise<boolean> {
  try {
    const out = execSync(`docker inspect --format='{{.State.Health.Status}}' ${name} 2>/dev/null`).toString().trim();
    return out === 'healthy' || out === ''; // kein healthcheck = ok
  } catch {
    return true;
  }
}

function getDiskUsage(path: string): number {
  try {
    const out = execSync(`df -k ${path} --output=pcent 2>/dev/null | tail -1`).toString().trim();
    return parseInt(out);
  } catch {
    return 0;
  }
}

function getRamUsage(): number {
  try {
    const out = execSync(`free | awk 'NR==2{printf "%.0f", $3*100/$2}'`).toString().trim();
    return parseInt(out);
  } catch {
    return 0;
  }
}

function isNginxRunning(): boolean {
  try {
    execSync('systemctl is-active nginx --quiet');
    return true;
  } catch {
    return false;
  }
}

// ─── Repair Actions ───────────────────────────────────────────────────────────

async function restartContainer(name: string, composePath: string): Promise<string> {
  try {
    const { stdout } = await execAsync(
      `docker compose -f ${composePath} restart ${name}`,
      { timeout: 60_000 }
    );
    return stdout.trim();
  } catch (err: any) {
    return err?.message ?? 'Fehler beim Restart';
  }
}

async function restartNginx(): Promise<string> {
  try {
    const { stdout } = await execAsync('systemctl restart nginx', { timeout: 15_000 });
    return stdout.trim() || 'OK';
  } catch (err: any) {
    return err?.message ?? 'Fehler';
  }
}

async function reloadSynapse(composePath: string): Promise<string> {
  try {
    // HUP Signal sendet Synapse zum Config-Reload + gibt RAM frei
    const { stdout } = await execAsync(
      `docker compose -f ${composePath} kill -s HUP synapse`,
      { timeout: 15_000 }
    );
    return stdout.trim() || 'OK';
  } catch (err: any) {
    return err?.message ?? 'Fehler';
  }
}

async function cleanDockerLogs(): Promise<string> {
  try {
    // Alte Docker Logs truncaten um Disk zu entlasten
    const { stdout } = await execAsync(
      `find /var/lib/docker/containers -name "*.log" -size +100M -exec truncate -s 0 {} \\;`,
      { timeout: 30_000 }
    );
    return 'Docker logs geleert';
  } catch (err: any) {
    return err?.message ?? 'Fehler';
  }
}

// ─── Main Health Check ────────────────────────────────────────────────────────

export async function runHealthCheck(): Promise<HealEvent[]> {
  const events: HealEvent[] = [];

  const composePath = getComposePath();

  if (!composePath) {
    // Noch kein Synapse installiert — kein Fehler, einfach überspringen
    return [];
  }

  // ── 1. Synapse Container ──────────────────────────────────────────────────
  const synapseRunning = await isContainerRunning('synapse') ||
                         await isContainerRunning('prilog-synapse-1');

  if (!synapseRunning) {
    logger.warn('Healer: Synapse ist down — starte neu...');
    const output = await restartContainer('synapse', composePath);
    events.push({
      type:    'synapse.down',
      message: 'Synapse Container war down und wurde neugestartet',
      healed:  true,
      ts:      new Date(),
      details: output,
    });
  } else {
    // Healthcheck
    const healthy = await isContainerHealthy('synapse') ||
                    await isContainerHealthy('prilog-synapse-1');
    if (!healthy) {
      logger.warn('Healer: Synapse unhealthy — restart...');
      const output = await restartContainer('synapse', composePath);
      events.push({
        type:    'docker.unhealthy',
        message: 'Synapse Container unhealthy — neugestartet',
        healed:  true,
        ts:      new Date(),
        details: output,
      });
    }
  }

  // ── 2. PostgreSQL Container ───────────────────────────────────────────────
  const postgresRunning = await isContainerRunning('postgres') ||
                          await isContainerRunning('prilog-postgres-1');

  if (!postgresRunning) {
    logger.warn('Healer: PostgreSQL ist down — starte neu...');
    const output = await restartContainer('postgres', composePath);
    events.push({
      type:    'postgres.down',
      message: 'PostgreSQL Container war down und wurde neugestartet',
      healed:  true,
      ts:      new Date(),
      details: output,
    });
  }

  // ── 3. Nginx ──────────────────────────────────────────────────────────────
  if (!isNginxRunning()) {
    logger.warn('Healer: Nginx ist down — starte neu...');
    const output = await restartNginx();
    events.push({
      type:    'nginx.down',
      message: 'Nginx war down und wurde neugestartet',
      healed:  true,
      ts:      new Date(),
      details: output,
    });
  }

  // ── 4. Disk-Auslastung ────────────────────────────────────────────────────
  const diskPaths = ['/opt/prilog', '/mnt/prilog-data', '/'];
  for (const path of diskPaths) {
    const usage = getDiskUsage(path);
    if (usage >= 90) {
      logger.warn(`Healer: Disk ${path} bei ${usage}%`);
      let details = `Disk ${path}: ${usage}% belegt`;

      // Bei >95%: Docker Logs leeren als Notfallmaßnahme
      if (usage >= 95) {
        const cleanResult = await cleanDockerLogs();
        details += ` → ${cleanResult}`;
      }

      events.push({
        type:    'disk.critical',
        message: `Disk-Auslastung kritisch: ${path} bei ${usage}%`,
        healed:  usage >= 95, // Nur "geheilt" wenn aktiv eingegriffen
        ts:      new Date(),
        details,
      });
    }
  }

  // ── 5. RAM-Auslastung ─────────────────────────────────────────────────────
  const ram = getRamUsage();
  if (ram >= 95) {
    logger.warn(`Healer: RAM bei ${ram}% — Synapse reload...`);
    const output = await reloadSynapse(composePath);
    events.push({
      type:    'ram.critical',
      message: `RAM-Auslastung kritisch: ${ram}% — Synapse Config-Reload ausgeführt`,
      healed:  true,
      ts:      new Date(),
      details: output,
    });
  }

  return events;
}
