/**
 * provision/steps/02-generate-synapse.ts
 *
 * Step 2: Synapse Config generieren und patchen.
 *
 * Ablauf:
 *  1. docker run matrixdotorg/synapse generate → erstellt /mnt/prilog-data/synapse/homeserver.yaml
 *  2. homeserver.yaml patchen:
 *     - database: SQLite → PostgreSQL
 *     - registration_shared_secret setzen
 *     - macaroon_secret_key setzen
 *     - form_secret setzen
 *     - allow_guest_access: false
 *     - enable_registration: false (standardmäßig gesperrt)
 *
 * Idempotenz: Prüft ob homeserver.yaml bereits PostgreSQL-Config enthält.
 */

import { exec, execSync } from 'child_process';
import { promisify } from 'util';
import * as fs        from 'fs';
import { ProvisionConfig } from '../types.js';
import { logger }          from '../../utils/logger.js';

const execAsync = promisify(exec);

const SYNAPSE_DATA_DIR  = '/mnt/prilog-data/synapse';
const HOMESERVER_YAML   = `${SYNAPSE_DATA_DIR}/homeserver.yaml`;

// ─── Idempotenz-Check ─────────────────────────────────────────────────────────

function isSynapseAlreadyConfigured(cfg: ProvisionConfig): boolean {
  try {
    const content = fs.readFileSync(HOMESERVER_YAML, 'utf-8');
    // PostgreSQL konfiguriert UND mit dem korrekten dbHost
    return (content.includes('psycopg2') || content.includes('postgresql'))
      && content.includes(`host: ${cfg.dbHost}`);
  } catch {
    return false;
  }
}

// ─── homeserver.yaml patchen ──────────────────────────────────────────────────
// Wir patchen die YAML-Datei zeilenweise statt einen YAML-Parser zu verwenden.
// Das ist robuster: keine Abhängigkeit von yaml-Bibliotheken, kein Verlust von Kommentaren.

function patchHomserverYaml(content: string, cfg: ProvisionConfig): string {
  let patched = content;

  // ── 1. SQLite Database → PostgreSQL ──────────────────────────────
  // Sucht den kompletten database-Block und ersetzt ihn.
  // Der generierte Block sieht so aus:
  //   database:
  //     name: sqlite3
  //     args:
  //       database: /path/to/homeserver.db

  const postgresBlock = `database:
  name: psycopg2
  args:
    user: synapse
    password: ${cfg.dbPassword}
    database: synapse
    host: ${cfg.dbHost}
    port: 5432
    cp_min: 5
    cp_max: 10
`;

  // Ersetze den database-Block (von "database:" bis zur nächsten Top-Level-Sektion)
  patched = patched.replace(
    /^database:\n(?:[ \t]+.*\n)*/m,
    postgresBlock
  );

  // ── 2. Secrets setzen ─────────────────────────────────────────────
  // registration_shared_secret
  if (patched.includes('registration_shared_secret:')) {
    patched = patched.replace(
      /^registration_shared_secret:.*$/m,
      `registration_shared_secret: "${cfg.registrationSecret}"`
    );
  } else {
    patched += `\nregistration_shared_secret: "${cfg.registrationSecret}"\n`;
  }

  // macaroon_secret_key
  if (patched.includes('macaroon_secret_key:')) {
    patched = patched.replace(
      /^macaroon_secret_key:.*$/m,
      `macaroon_secret_key: "${cfg.macaroonSecret}"`
    );
  } else {
    patched += `macaroon_secret_key: "${cfg.macaroonSecret}"\n`;
  }

  // form_secret
  if (patched.includes('form_secret:')) {
    patched = patched.replace(
      /^form_secret:.*$/m,
      `form_secret: "${cfg.formSecret}"`
    );
  } else {
    patched += `form_secret: "${cfg.formSecret}"\n`;
  }

  // ── 3. Sicherheits-Defaults ───────────────────────────────────────
  // Gastzugang und offene Registrierung standardmäßig deaktiviert

  if (patched.includes('allow_guest_access:')) {
    patched = patched.replace(
      /^allow_guest_access:.*$/m,
      'allow_guest_access: false'
    );
  } else {
    patched += 'allow_guest_access: false\n';
  }

  if (patched.includes('enable_registration:')) {
    patched = patched.replace(
      /^enable_registration:.*$/m,
      'enable_registration: false'
    );
  } else {
    patched += 'enable_registration: false\n';
  }

  // ── 4. Upload-Größe ───────────────────────────────────────────────
  const maxUploadMb = `${cfg.maxUploadSize}M`;
  if (patched.includes('max_upload_size:')) {
    patched = patched.replace(
      /^max_upload_size:.*$/m,
      `max_upload_size: ${maxUploadMb}`
    );
  } else {
    patched += `max_upload_size: ${maxUploadMb}\n`;
  }

  return patched;
}

// ─── Step ─────────────────────────────────────────────────────────────────────

export async function stepGenerateSynapse(cfg: ProvisionConfig): Promise<void> {
  // ── Idempotenz ────────────────────────────────────────────────────
  if (isSynapseAlreadyConfigured(cfg)) {
    logger.info('[Step 2] homeserver.yaml bereits konfiguriert — überspringe generate');
    return;
  }

  // ── Verzeichnis sicherstellen ────────────────────────────────────
  fs.mkdirSync(SYNAPSE_DATA_DIR, { recursive: true });

  // ── Synapse Config generieren ────────────────────────────────────
  logger.info('[Step 2] Generiere Synapse Config...');

  const generateCmd = [
    'docker run --rm',
    `-v ${SYNAPSE_DATA_DIR}:/data`,
    `-e SYNAPSE_SERVER_NAME=${cfg.matrixDomain}`,
    '-e SYNAPSE_REPORT_STATS=no',
    'matrixdotorg/synapse:latest generate',
  ].join(' ');

  await execAsync(generateCmd, { timeout: 120_000 });

  if (!fs.existsSync(HOMESERVER_YAML)) {
    throw new Error(`homeserver.yaml wurde nicht erstellt: ${HOMESERVER_YAML}`);
  }

  logger.info('[Step 2] homeserver.yaml generiert');

  // ── homeserver.yaml patchen ───────────────────────────────────────
  logger.info('[Step 2] Patche homeserver.yaml (PostgreSQL + Secrets)...');

  const original = fs.readFileSync(HOMESERVER_YAML, 'utf-8');
  const patched  = patchHomserverYaml(original, cfg);

  // Backup des Original-Files
  fs.writeFileSync(`${HOMESERVER_YAML}.original`, original, 'utf-8');
  fs.writeFileSync(HOMESERVER_YAML, patched, 'utf-8');

  logger.info('[Step 2] homeserver.yaml gepatcht');

  // ── Dateirechte setzen (Synapse läuft als UID 991) ─────────────
  await execAsync(`chown -R 991:991 ${SYNAPSE_DATA_DIR}`, { timeout: 15_000 });
  logger.info('[Step 2] Dateirechte gesetzt');
}

export async function verifyGenerateSynapse(_cfg: ProvisionConfig): Promise<void> {
  try {
    execSync(`test -f ${HOMESERVER_YAML}`, { stdio: 'ignore' });
  } catch {
    throw new Error('homeserver.yaml fehlt nach Synapse-Generate');
  }
  const keys = fs.readdirSync(SYNAPSE_DATA_DIR).filter(f => f.endsWith('.signing.key'));
  if (keys.length === 0) {
    throw new Error('signing.key fehlt nach Synapse-Generate');
  }
}
