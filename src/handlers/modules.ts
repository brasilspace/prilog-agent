import { execSync } from 'child_process';
import * as fs from 'fs';
import { ModuleInfo } from '../types.js';
import { logger } from '../utils/logger.js';

const MODULES_DIR = '/opt/prilog/modules';

// ─── Verfügbare Module entdecken ─────────────────────────────────────────────

export function discoverModules(): string[] {
  try {
    if (!fs.existsSync(MODULES_DIR)) return [];
    return fs.readdirSync(MODULES_DIR).filter(name => {
      const composePath = `${MODULES_DIR}/${name}/docker-compose.yml`;
      return fs.existsSync(composePath);
    });
  } catch {
    return [];
  }
}

// ─── Status aller Module ──────────────────────────────────────────────────────

export function getModuleStatus(): ModuleInfo[] {
  const discovered = discoverModules();

  // Laufende Container mit prilog.module Label
  let runningContainers: string[] = [];
  try {
    const out = execSync('docker ps --filter "label=prilog.module" --format "{{.Names}}"')
      .toString().trim();
    runningContainers = out ? out.split('\n') : [];
  } catch {
    // Docker nicht verfügbar
  }

  return discovered.map(name => {
    const running = runningContainers.some(c => c.includes(name));
    let version: string | undefined;

    try {
      const composePath = `${MODULES_DIR}/${name}/docker-compose.yml`;
      const content = fs.readFileSync(composePath, 'utf8');
      const match = content.match(/image:.*:([^\s]+)/);
      if (match) version = match[1];
    } catch {
      // kein version
    }

    return { name, enabled: running, running, version };
  });
}

// ─── Module ein-/ausschalten ─────────────────────────────────────────────────

export async function enableModule(moduleName: string): Promise<{ success: boolean; output: string }> {
  // Sicherheitscheck: kein Path Traversal
  if (!/^[a-z0-9_-]+$/.test(moduleName)) {
    return { success: false, output: 'Ungültiger Modulname' };
  }

  const composePath = `${MODULES_DIR}/${moduleName}/docker-compose.yml`;
  if (!fs.existsSync(composePath)) {
    return { success: false, output: `Modul nicht gefunden: ${moduleName}` };
  }

  try {
    const out = execSync(
      `docker compose -f ${composePath} up -d`,
      { timeout: 60_000 }
    ).toString();
    logger.info(`Module enabled: ${moduleName}`);
    return { success: true, output: out };
  } catch (err: any) {
    return { success: false, output: err?.message ?? 'Fehler' };
  }
}

export async function disableModule(moduleName: string): Promise<{ success: boolean; output: string }> {
  if (!/^[a-z0-9_-]+$/.test(moduleName)) {
    return { success: false, output: 'Ungültiger Modulname' };
  }

  const composePath = `${MODULES_DIR}/${moduleName}/docker-compose.yml`;
  if (!fs.existsSync(composePath)) {
    return { success: false, output: `Modul nicht gefunden: ${moduleName}` };
  }

  try {
    const out = execSync(
      `docker compose -f ${composePath} down`,
      { timeout: 30_000 }
    ).toString();
    logger.info(`Module disabled: ${moduleName}`);
    return { success: true, output: out };
  } catch (err: any) {
    return { success: false, output: err?.message ?? 'Fehler' };
  }
}
