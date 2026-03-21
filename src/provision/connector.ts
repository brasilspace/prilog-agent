import { execSync } from 'child_process';
import * as fs from 'fs';

import { parseDocument, YAMLSeq, isMap } from 'yaml';

import { logger } from '../utils/logger.js';
import { ProvisionConfig } from './types.js';
import { COMPOSE_PATH, CONNECTOR_HOST_DIR, writeComposeFile } from './compose.js';

const HOMESERVER_YAML = '/mnt/prilog-data/synapse/homeserver.yaml';
const CONNECTOR_PACKAGE_REPO = 'https://github.com/brasilspace/prilog-matrix-connector';
const CONNECTOR_MODULE_NAME = 'prilog_matrix_connector';
const CONNECTOR_MODULE_CLASS = 'prilog_matrix_connector.module.PrilogMatrixConnectorModule';

interface EnsureConnectorOptions {
  refreshCompose?: boolean;
  restartSynapse?: boolean;
}

export function getEnabledConnector(config: ProvisionConfig) {
  const connector = config.synapseModules?.connector;
  if (!connector?.enabled) return null;
  return connector;
}

function execChecked(command: string, timeout = 60_000): string {
  logger.info(`[Connector] ${command}`);
  return execSync(command, { timeout, stdio: ['ignore', 'pipe', 'pipe'] }).toString().trim();
}

function ensureGitCheckout(repo: string, ref: string): void {
  if (!fs.existsSync(CONNECTOR_HOST_DIR)) {
    fs.mkdirSync('/opt/synapse/connectors', { recursive: true });
    execChecked(`git clone --depth 1 --branch ${ref} ${repo} ${CONNECTOR_HOST_DIR}`, 120_000);
    return;
  }

  if (!fs.existsSync(`${CONNECTOR_HOST_DIR}/.git`)) {
    throw new Error(`Connector-Ziel existiert ohne Git-Metadaten: ${CONNECTOR_HOST_DIR}`);
  }

  execChecked(`git -C ${CONNECTOR_HOST_DIR} fetch origin ${ref} --depth 1`, 120_000);
  execChecked(`git -C ${CONNECTOR_HOST_DIR} checkout ${ref}`);
  execChecked(`git -C ${CONNECTOR_HOST_DIR} reset --hard origin/${ref}`);
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

function restartSynapseIfRequested(shouldRestart: boolean): void {
  if (!shouldRestart) return;
  if (!fs.existsSync(COMPOSE_PATH)) {
    throw new Error(`docker-compose.yml fehlt fuer Connector-Restart: ${COMPOSE_PATH}`);
  }

  execChecked(`docker compose -f ${COMPOSE_PATH} up -d synapse`, 120_000);
}

export function ensureMatrixConnectorInstalled(
  config: ProvisionConfig,
  options: EnsureConnectorOptions = {},
): { changed: boolean; message: string } {
  const connector = getEnabledConnector(config);

  upsertConnectorModule(config);

  if (!connector) {
    if (options.refreshCompose) {
      writeComposeFile(config);
    }
    verifyConnectorConfigured(config);
    return { changed: false, message: 'Connector ist fuer diesen Tenant nicht aktiviert' };
  }

  ensureGitCheckout(connector.packageRepo || CONNECTOR_PACKAGE_REPO, connector.packageRef || 'main');
  verifyCheckout();
  upsertConnectorModule(config);

  if (options.refreshCompose) {
    writeComposeFile(config);
  }

  verifyConnectorConfigured(config);
  restartSynapseIfRequested(Boolean(options.restartSynapse));

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
