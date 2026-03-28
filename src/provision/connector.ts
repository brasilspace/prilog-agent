import * as fs from 'fs';

import { parseDocument, YAMLSeq, isMap } from 'yaml';

import { logger } from '../utils/logger.js';
import { ProvisionConfig } from './types.js';
import { COMPOSE_PATH, CONNECTOR_HOST_DIR, writeComposeFile } from './compose.js';
import { safeExec, dockerCompose } from './engine/safe-exec.js';

const HOMESERVER_YAML = '/mnt/prilog-data/synapse/homeserver.yaml';
const CONNECTOR_PACKAGE_REPO = 'git@github.com:brasilspace/prilog-matrix-connector.git';
const CONNECTOR_MODULE_NAME = 'prilog_matrix_connector';
const CONNECTOR_MODULE_CLASS = 'prilog_matrix_connector.module.PrilogMatrixConnectorModule';
const CONNECTOR_TMP_ARCHIVE = '/tmp/prilog-matrix-connector.tar.gz';

interface EnsureConnectorOptions {
  refreshCompose?: boolean;
  restartSynapse?: boolean;
}

export function getEnabledConnector(config: ProvisionConfig) {
  const connector = config.synapseModules?.connector;
  if (!connector?.enabled) return null;
  return connector;
}

async function ensureGitCheckout(repo: string, ref: string): Promise<void> {
  const isGithubSshRepo = repo.startsWith('git@github.com:');

  if (!fs.existsSync(CONNECTOR_HOST_DIR)) {
    fs.mkdirSync('/opt/prilog/connectors', { recursive: true });
    try {
      await safeExec('git', ['clone', '--depth', '1', '--branch', ref, repo, CONNECTOR_HOST_DIR], { timeout: 120_000 });
    } catch (error) {
      if (isGithubSshRepo) {
        throw new Error(
          `Connector-Repository konnte nicht per SSH geklont werden. Bitte Deploy-Key oder SSH-Zugang fuer ${repo} auf diesem Kundenserver hinterlegen.`,
        );
      }
      throw error;
    }
    return;
  }

  if (!fs.existsSync(`${CONNECTOR_HOST_DIR}/.git`)) {
    throw new Error(`Connector-Ziel existiert ohne Git-Metadaten: ${CONNECTOR_HOST_DIR}`);
  }

  try {
    await safeExec('git', ['-C', CONNECTOR_HOST_DIR, 'fetch', 'origin', ref, '--depth', '1'], { timeout: 120_000 });
  } catch (error) {
    if (isGithubSshRepo) {
      throw new Error(
        `Connector-Repository konnte nicht per SSH aktualisiert werden. Bitte Deploy-Key oder SSH-Zugang fuer ${repo} auf diesem Kundenserver pruefen.`,
      );
    }
    throw error;
  }
  await safeExec('git', ['-C', CONNECTOR_HOST_DIR, 'checkout', ref]);
  await safeExec('git', ['-C', CONNECTOR_HOST_DIR, 'reset', '--hard', `origin/${ref}`]);
}

async function ensureArtifactExtracted(url: string, sharedSecret?: string): Promise<void> {
  fs.mkdirSync('/opt/prilog/connectors', { recursive: true });
  if (fs.existsSync(CONNECTOR_HOST_DIR)) {
    fs.rmSync(CONNECTOR_HOST_DIR, { recursive: true, force: true });
  }
  if (fs.existsSync(CONNECTOR_TMP_ARCHIVE)) {
    fs.unlinkSync(CONNECTOR_TMP_ARCHIVE);
  }

  const curlArgs = ['-fsSL', url, '-o', CONNECTOR_TMP_ARCHIVE];
  if (sharedSecret) {
    curlArgs.unshift('-H', `x-matrix-connector-secret: ${sharedSecret}`);
  }

  try {
    await safeExec('curl', curlArgs, { timeout: 120_000 });
  } catch (error) {
    throw new Error(`Connector-Artefakt konnte nicht geladen werden: ${url}`);
  }

  fs.mkdirSync(CONNECTOR_HOST_DIR, { recursive: true });
  await safeExec('tar', ['-xzf', CONNECTOR_TMP_ARCHIVE, '-C', CONNECTOR_HOST_DIR, '--strip-components=1'], { timeout: 120_000 });
}

function verifyCheckout(): void {
  const requiredFiles = [
    `${CONNECTOR_HOST_DIR}/pyproject.toml`,
    `${CONNECTOR_HOST_DIR}/src/${CONNECTOR_MODULE_NAME}/module.py`,
  ];

  for (const file of requiredFiles) {
    if (!fs.existsSync(file)) {
      throw new Error(`Connector-Datei fehlt nach Checkout: ${file}`);
    }
  }
}

function buildConnectorConfig(config: ProvisionConfig) {
  const connector = getEnabledConnector(config);
  if (!connector) return null;

  return {
    prilog_api_url: connector.config.prilogApiUrl,
    shared_secret: connector.config.sharedSecret,
    tenant_id: connector.config.tenantId ?? null,
    tenant_key: connector.config.tenantKey ?? null,
    subdomain: connector.config.subdomain ?? config.subdomain,
    allow_server_admin_bypass: connector.config.allowServerAdminBypass,
    request_timeout_seconds: connector.config.requestTimeoutSeconds,
  };
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

function upsertConnectorModule(config: ProvisionConfig): void {
  if (!fs.existsSync(HOMESERVER_YAML)) {
    throw new Error(`homeserver.yaml fehlt: ${HOMESERVER_YAML}`);
  }

  const content = fs.readFileSync(HOMESERVER_YAML, 'utf-8');
  const doc = parseDocument(content);
  const modules = ensureModulesNode(doc);
  const connectorConfig = buildConnectorConfig(config);
  const items = [...modules.items];

  const existingIndex = items.findIndex((item) => {
    if (!isMap(item)) return false;
    return item.get('module') === CONNECTOR_MODULE_CLASS;
  });

  if (!connectorConfig) {
    if (existingIndex >= 0) {
      modules.items.splice(existingIndex, 1);
    }
  } else {
    const nextNode = doc.createNode({
      module: CONNECTOR_MODULE_CLASS,
      config: connectorConfig,
    });

    if (existingIndex >= 0) {
      modules.items.splice(existingIndex, 1, nextNode);
    } else {
      modules.add(nextNode);
    }
  }

  fs.writeFileSync(HOMESERVER_YAML, String(doc), 'utf-8');
}

function verifyConnectorConfigured(config: ProvisionConfig): void {
  const content = fs.readFileSync(HOMESERVER_YAML, 'utf-8');
  const connector = getEnabledConnector(config);

  if (!connector) {
    if (content.includes(CONNECTOR_MODULE_CLASS)) {
      throw new Error('Connector-Modulblock ist trotz deaktiviertem Connector noch in homeserver.yaml vorhanden');
    }
    return;
  }

  if (!content.includes(CONNECTOR_MODULE_CLASS)) {
    throw new Error('Connector-Modulklasse fehlt in homeserver.yaml');
  }

  if (!content.includes(connector.config.prilogApiUrl)) {
    throw new Error('Connector-API-URL fehlt in homeserver.yaml');
  }
}

async function restartSynapseIfRequested(shouldRestart: boolean): Promise<void> {
  if (!shouldRestart) return;
  if (!fs.existsSync(COMPOSE_PATH)) {
    throw new Error(`docker-compose.yml fehlt fuer Connector-Restart: ${COMPOSE_PATH}`);
  }

  await dockerCompose(COMPOSE_PATH, ['up', '-d', 'synapse'], { timeout: 120_000 });
}

export async function ensureMatrixConnectorInstalled(
  config: ProvisionConfig,
  options: EnsureConnectorOptions = {},
): Promise<{ changed: boolean; message: string }> {
  const connector = getEnabledConnector(config);

  upsertConnectorModule(config);

  if (!connector) {
    if (options.refreshCompose) {
      writeComposeFile(config);
    }
    verifyConnectorConfigured(config);
    return { changed: false, message: 'Connector ist fuer diesen Tenant nicht aktiviert' };
  }

  if (connector.packageUrl) {
    await ensureArtifactExtracted(connector.packageUrl, connector.config.sharedSecret);
  } else {
    await ensureGitCheckout(connector.packageRepo || CONNECTOR_PACKAGE_REPO, connector.packageRef || 'main');
  }
  verifyCheckout();
  upsertConnectorModule(config);

  if (options.refreshCompose) {
    writeComposeFile(config);
  }

  verifyConnectorConfigured(config);
  await restartSynapseIfRequested(Boolean(options.restartSynapse));

  return {
    changed: true,
    message: `Connector ${connector.moduleName} vorbereitet (${CONNECTOR_HOST_DIR})`,
  };
}

export function verifyMatrixConnectorInstalled(config: ProvisionConfig): void {
  const connector = getEnabledConnector(config);

  if (connector) {
    verifyCheckout();
  }

  verifyConnectorConfigured(config);
}
