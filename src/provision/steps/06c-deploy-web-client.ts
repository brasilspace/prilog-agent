/**
 * provision/steps/06c-deploy-web-client.ts
 *
 * Step 06c: Deploy Prilog Web Client
 * Downloads the latest web-client build and extracts to /var/www/prilog-web-client/
 *
 * Idempotenz: Ueberschreibt vorhandene Dateien — gleicher Inhalt bei gleichem Artifact.
 */

import * as fs from 'fs';
import { ProvisionConfig } from '../types.js';
import { logger }          from '../../utils/logger.js';
import { safeExec }        from '../engine/safe-exec.js';

const WEB_CLIENT_DIR = '/var/www/prilog-web-client';
const ARTIFACT_TMP   = '/tmp/prilog-web-client.tar.gz';

// ─── Download & Extract ──────────────────────────────────────────────────────

export async function deployWebClient(config: ProvisionConfig): Promise<void> {
  const artifactUrl = config.webClientArtifactUrl;
  if (!artifactUrl) {
    throw new Error('webClientArtifactUrl nicht in ProvisionConfig gesetzt');
  }

  // ── Zielverzeichnis anlegen ──────────────────────────────────────
  await safeExec('mkdir', ['-p', WEB_CLIENT_DIR], { timeout: 5_000 });
  logger.info('[Step 06c] Verzeichnis erstellt: ' + WEB_CLIENT_DIR);

  // ── Artifact herunterladen ───────────────────────────────────────
  logger.info('[Step 06c] Lade Web-Client Artifact herunter...');
  const curlArgs = ['-fSL', '--max-time', '120', '-o', ARTIFACT_TMP];

  // Shared Secret für authentifizierten Download über Backend
  const sharedSecret = config.synapseModules?.connector?.config?.sharedSecret;
  if (sharedSecret) {
    curlArgs.push('-H', `x-matrix-connector-secret: ${sharedSecret}`);
  }

  curlArgs.push(artifactUrl);

  await safeExec('curl', curlArgs, { timeout: 130_000 });
  logger.info('[Step 06c] Artifact heruntergeladen');

  // ── Alte Assets aufraeumen (verhindert Anhaeufung alter Build-Dateien) ───
  const assetsDir = `${WEB_CLIENT_DIR}/assets`;
  if (fs.existsSync(assetsDir)) {
    await safeExec('rm', ['-rf', assetsDir], { timeout: 10_000 });
    logger.info('[Step 06c] Alte Assets entfernt');
  }

  // ── Entpacken (dist/ Inhalt nach /var/www/prilog-web-client/) ───
  await safeExec('tar', [
    '-xzf', ARTIFACT_TMP,
    '-C', WEB_CLIENT_DIR,
    '--strip-components=1',
  ], { timeout: 30_000 });
  logger.info('[Step 06c] Artifact entpackt');

  // ── Aufräumen ────────────────────────────────────────────────────
  await safeExec('rm', ['-f', ARTIFACT_TMP], { timeout: 5_000 });

  // ── Berechtigungen setzen ────────────────────────────────────────
  await safeExec('chown', ['-R', 'www-data:www-data', WEB_CLIENT_DIR], { timeout: 10_000 });
  logger.info('[Step 06c] Berechtigungen gesetzt');
}

// ─── Step ────────────────────────────────────────────────────────────────────

export async function stepDeployWebClient(config: ProvisionConfig): Promise<void> {
  logger.info('[Step 06c] Deploye Prilog Web Client...');
  await deployWebClient(config);
  logger.info('[Step 06c] Web Client deployed');
}

// ─── Verify ──────────────────────────────────────────────────────────────────

export async function verifyDeployWebClient(_config: ProvisionConfig): Promise<void> {
  const indexPath = `${WEB_CLIENT_DIR}/index.html`;
  if (!fs.existsSync(indexPath)) {
    throw new Error(`Web Client Verifikation fehlgeschlagen: ${indexPath} nicht gefunden`);
  }
  logger.info('[Step 06c] Verifikation OK — index.html vorhanden');
}
