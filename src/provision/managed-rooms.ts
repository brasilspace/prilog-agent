/**
 * provision/managed-rooms.ts
 *
 * Installiert und konfiguriert `synapse-managed-rooms` idempotent — das Modul,
 * das die sechs Wege schliesst, auf denen an Prilog vorbei Raeume entstehen,
 * Leute eingeladen oder Raeume auffindbar gemacht werden.
 *
 * Aufbau bewusst wie bei connector.ts: Artefakt laden, entpacken, Modulblock in
 * homeserver.yaml setzen, spaeterer Compose-Step mountet ins Synapse-Zimmer.
 * Wer das eine versteht, versteht das andere.
 *
 * Der Agent rechnet hier NICHTS aus. deny, exempt und die beiden Schalter
 * kommen fertig aus dem Backend — die Dienstkonten-Muster sind die Stelle, an
 * der ein Fehler den Tenant aussperrt, und die gehoert an EINEN Ort.
 */

import * as fs from 'fs';

import { parseDocument, YAMLSeq, isMap } from 'yaml';

import { logger } from '../utils/logger.js';
import { ProvisionConfig } from './types.js';
import { COMPOSE_PATH, MANAGED_ROOMS_HOST_DIR, writeComposeFile } from './compose.js';
import { safeExec, dockerCompose } from './engine/safe-exec.js';

const HOMESERVER_YAML = '/mnt/prilog-data/synapse/homeserver.yaml';
const MODULE_CLASS = 'synapse_managed_rooms.ManagedRoomsModule';
const TMP_ARCHIVE = '/tmp/synapse-managed-rooms.tar.gz';

interface EnsureOptions {
  refreshCompose?: boolean;
  restartSynapse?: boolean;
}

export function getEnabledManagedRooms(config: ProvisionConfig) {
  const managedRooms = config.synapseModules?.managedRooms;
  if (!managedRooms?.enabled) return null;
  return managedRooms;
}

async function ensureArtifactExtracted(url: string): Promise<void> {
  fs.mkdirSync('/opt/prilog/modules', { recursive: true });
  if (fs.existsSync(MANAGED_ROOMS_HOST_DIR)) {
    fs.rmSync(MANAGED_ROOMS_HOST_DIR, { recursive: true, force: true });
  }
  if (fs.existsSync(TMP_ARCHIVE)) {
    fs.unlinkSync(TMP_ARCHIVE);
  }

  try {
    await safeExec('curl', ['-fsSL', url, '-o', TMP_ARCHIVE], { timeout: 120_000 });
  } catch {
    throw new Error(`managed-rooms-Artefakt konnte nicht geladen werden: ${url}`);
  }

  fs.mkdirSync(MANAGED_ROOMS_HOST_DIR, { recursive: true });
  await safeExec(
    'tar',
    ['-xzf', TMP_ARCHIVE, '-C', MANAGED_ROOMS_HOST_DIR, '--strip-components=1'],
    { timeout: 120_000 },
  );
}

function verifyExtracted(): void {
  const required = [
    `${MANAGED_ROOMS_HOST_DIR}/synapse_managed_rooms/module.py`,
    `${MANAGED_ROOMS_HOST_DIR}/synapse_managed_rooms/config.py`,
    `${MANAGED_ROOMS_HOST_DIR}/synapse_managed_rooms/direct_messages.py`,
  ];

  for (const file of required) {
    if (!fs.existsSync(file)) {
      throw new Error(`managed-rooms-Datei fehlt nach Entpacken: ${file}`);
    }
  }
}

function ensureModulesNode(doc: ReturnType<typeof parseDocument>): YAMLSeq {
  const existing = doc.get('modules', true);
  if (existing instanceof YAMLSeq) {
    return existing;
  }
  const modules = doc.createNode([]) as YAMLSeq;
  doc.set('modules', modules);
  return modules;
}

function upsertModuleBlock(config: ProvisionConfig): void {
  if (!fs.existsSync(HOMESERVER_YAML)) {
    throw new Error(`homeserver.yaml fehlt: ${HOMESERVER_YAML}`);
  }

  const doc = parseDocument(fs.readFileSync(HOMESERVER_YAML, 'utf-8'));
  const modules = ensureModulesNode(doc);
  const managedRooms = getEnabledManagedRooms(config);

  const existingIndex = modules.items.findIndex(
    (item) => isMap(item) && item.get('module') === MODULE_CLASS,
  );

  if (!managedRooms) {
    if (existingIndex >= 0) {
      modules.items.splice(existingIndex, 1);
    }
  } else {
    const nextNode = doc.createNode({
      module: MODULE_CLASS,
      config: managedRooms.config,
    });

    if (existingIndex >= 0) {
      modules.items.splice(existingIndex, 1, nextNode);
    } else {
      modules.add(nextNode);
    }
  }

  fs.writeFileSync(HOMESERVER_YAML, String(doc), 'utf-8');
}

function verifyConfigured(config: ProvisionConfig): void {
  const content = fs.readFileSync(HOMESERVER_YAML, 'utf-8');
  const managedRooms = getEnabledManagedRooms(config);

  if (!managedRooms) {
    if (content.includes(MODULE_CLASS)) {
      throw new Error('managed-rooms-Modulblock steht in homeserver.yaml, obwohl das Modul aus ist');
    }
    return;
  }

  if (!content.includes(MODULE_CLASS)) {
    throw new Error('managed-rooms-Modulklasse fehlt in homeserver.yaml');
  }

  // Ohne exempt-Regel sperrt sich Prilog selbst aus: Raeume anlegen, Leute
  // eintragen, Aliase — alles laeuft ueber Dienstkonten. Lieber hier laut
  // scheitern als spaeter still.
  if (managedRooms.config.deny.length > 0 && managedRooms.config.exempt.length === 0) {
    throw new Error(
      'managed-rooms verbietet Aktionen, aber es ist keine exempt-Regel gesetzt — ' +
        'das wuerde Prilogs eigene Dienstkonten aussperren',
    );
  }

  for (const rule of managedRooms.config.exempt) {
    if (!content.includes(rule.match)) {
      throw new Error(`managed-rooms: exempt-Muster fehlt in homeserver.yaml: ${rule.match}`);
    }
  }
}

async function restartSynapseIfRequested(shouldRestart: boolean): Promise<void> {
  if (!shouldRestart) return;
  if (!fs.existsSync(COMPOSE_PATH)) {
    throw new Error(`docker-compose.yml fehlt fuer managed-rooms-Restart: ${COMPOSE_PATH}`);
  }
  await dockerCompose(COMPOSE_PATH, ['up', '-d', 'synapse'], { timeout: 120_000 });
}

export async function ensureManagedRoomsInstalled(
  config: ProvisionConfig,
  options: EnsureOptions = {},
): Promise<{ changed: boolean; message: string }> {
  const managedRooms = getEnabledManagedRooms(config);

  upsertModuleBlock(config);

  if (!managedRooms) {
    if (options.refreshCompose) {
      writeComposeFile(config);
    }
    verifyConfigured(config);
    return { changed: false, message: 'managed-rooms ist fuer diesen Tenant nicht aktiviert' };
  }

  if (!managedRooms.packageUrl) {
    throw new Error('managed-rooms ist aktiviert, aber es ist keine packageUrl gesetzt');
  }

  await ensureArtifactExtracted(managedRooms.packageUrl);
  verifyExtracted();
  upsertModuleBlock(config);

  if (options.refreshCompose) {
    writeComposeFile(config);
  }

  verifyConfigured(config);
  await restartSynapseIfRequested(Boolean(options.restartSynapse));

  logger.info(
    `[managed-rooms] verboten: ${managedRooms.config.deny.join(', ') || 'nichts'} | ` +
      `Ausnahmen: ${managedRooms.config.exempt.length} | ` +
      `Direktnachrichten: ${managedRooms.config.allow_direct_messages ? 'erlaubt' : 'nein'}`,
  );

  return {
    changed: true,
    message: `managed-rooms vorbereitet (${MANAGED_ROOMS_HOST_DIR})`,
  };
}

export function verifyManagedRoomsInstalled(config: ProvisionConfig): void {
  if (getEnabledManagedRooms(config)) {
    verifyExtracted();
  }
  verifyConfigured(config);
}
