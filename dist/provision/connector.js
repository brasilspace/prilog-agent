"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.getEnabledConnector = getEnabledConnector;
exports.ensureMatrixConnectorInstalled = ensureMatrixConnectorInstalled;
exports.verifyMatrixConnectorInstalled = verifyMatrixConnectorInstalled;
const fs = __importStar(require("fs"));
const yaml_1 = require("yaml");
const compose_js_1 = require("./compose.js");
const safe_exec_js_1 = require("./engine/safe-exec.js");
const HOMESERVER_YAML = '/mnt/prilog-data/synapse/homeserver.yaml';
const CONNECTOR_PACKAGE_REPO = 'git@github.com:brasilspace/prilog-matrix-connector.git';
const CONNECTOR_MODULE_NAME = 'prilog_matrix_connector';
const CONNECTOR_MODULE_CLASS = 'prilog_matrix_connector.module.PrilogMatrixConnectorModule';
const CONNECTOR_TMP_ARCHIVE = '/tmp/prilog-matrix-connector.tar.gz';
function getEnabledConnector(config) {
    const connector = config.synapseModules?.connector;
    if (!connector?.enabled)
        return null;
    return connector;
}
async function ensureGitCheckout(repo, ref) {
    const isGithubSshRepo = repo.startsWith('git@github.com:');
    if (!fs.existsSync(compose_js_1.CONNECTOR_HOST_DIR)) {
        fs.mkdirSync('/opt/prilog/connectors', { recursive: true });
        try {
            await (0, safe_exec_js_1.safeExec)('git', ['clone', '--depth', '1', '--branch', ref, repo, compose_js_1.CONNECTOR_HOST_DIR], { timeout: 120_000 });
        }
        catch (error) {
            if (isGithubSshRepo) {
                throw new Error(`Connector-Repository konnte nicht per SSH geklont werden. Bitte Deploy-Key oder SSH-Zugang fuer ${repo} auf diesem Kundenserver hinterlegen.`);
            }
            throw error;
        }
        return;
    }
    if (!fs.existsSync(`${compose_js_1.CONNECTOR_HOST_DIR}/.git`)) {
        throw new Error(`Connector-Ziel existiert ohne Git-Metadaten: ${compose_js_1.CONNECTOR_HOST_DIR}`);
    }
    try {
        await (0, safe_exec_js_1.safeExec)('git', ['-C', compose_js_1.CONNECTOR_HOST_DIR, 'fetch', 'origin', ref, '--depth', '1'], { timeout: 120_000 });
    }
    catch (error) {
        if (isGithubSshRepo) {
            throw new Error(`Connector-Repository konnte nicht per SSH aktualisiert werden. Bitte Deploy-Key oder SSH-Zugang fuer ${repo} auf diesem Kundenserver pruefen.`);
        }
        throw error;
    }
    await (0, safe_exec_js_1.safeExec)('git', ['-C', compose_js_1.CONNECTOR_HOST_DIR, 'checkout', ref]);
    await (0, safe_exec_js_1.safeExec)('git', ['-C', compose_js_1.CONNECTOR_HOST_DIR, 'reset', '--hard', `origin/${ref}`]);
}
async function ensureArtifactExtracted(url, sharedSecret) {
    fs.mkdirSync('/opt/prilog/connectors', { recursive: true });
    if (fs.existsSync(compose_js_1.CONNECTOR_HOST_DIR)) {
        fs.rmSync(compose_js_1.CONNECTOR_HOST_DIR, { recursive: true, force: true });
    }
    if (fs.existsSync(CONNECTOR_TMP_ARCHIVE)) {
        fs.unlinkSync(CONNECTOR_TMP_ARCHIVE);
    }
    const curlArgs = ['-fsSL', url, '-o', CONNECTOR_TMP_ARCHIVE];
    if (sharedSecret) {
        curlArgs.unshift('-H', `x-matrix-connector-secret: ${sharedSecret}`);
    }
    try {
        await (0, safe_exec_js_1.safeExec)('curl', curlArgs, { timeout: 120_000 });
    }
    catch (error) {
        throw new Error(`Connector-Artefakt konnte nicht geladen werden: ${url}`);
    }
    fs.mkdirSync(compose_js_1.CONNECTOR_HOST_DIR, { recursive: true });
    await (0, safe_exec_js_1.safeExec)('tar', ['-xzf', CONNECTOR_TMP_ARCHIVE, '-C', compose_js_1.CONNECTOR_HOST_DIR, '--strip-components=1'], { timeout: 120_000 });
}
function verifyCheckout() {
    const requiredFiles = [
        `${compose_js_1.CONNECTOR_HOST_DIR}/pyproject.toml`,
        `${compose_js_1.CONNECTOR_HOST_DIR}/src/${CONNECTOR_MODULE_NAME}/module.py`,
    ];
    for (const file of requiredFiles) {
        if (!fs.existsSync(file)) {
            throw new Error(`Connector-Datei fehlt nach Checkout: ${file}`);
        }
    }
}
function buildConnectorConfig(config) {
    const connector = getEnabledConnector(config);
    if (!connector)
        return null;
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
function ensureModulesNode(doc) {
    const existing = doc.get('modules', true);
    if (existing instanceof yaml_1.YAMLSeq) {
        return existing;
    }
    const modules = doc.createNode([]);
    doc.set('modules', modules);
    return modules;
}
function upsertConnectorModule(config) {
    if (!fs.existsSync(HOMESERVER_YAML)) {
        throw new Error(`homeserver.yaml fehlt: ${HOMESERVER_YAML}`);
    }
    const content = fs.readFileSync(HOMESERVER_YAML, 'utf-8');
    const doc = (0, yaml_1.parseDocument)(content);
    const modules = ensureModulesNode(doc);
    const connectorConfig = buildConnectorConfig(config);
    const items = [...modules.items];
    const existingIndex = items.findIndex((item) => {
        if (!(0, yaml_1.isMap)(item))
            return false;
        return item.get('module') === CONNECTOR_MODULE_CLASS;
    });
    if (!connectorConfig) {
        if (existingIndex >= 0) {
            modules.items.splice(existingIndex, 1);
        }
    }
    else {
        const nextNode = doc.createNode({
            module: CONNECTOR_MODULE_CLASS,
            config: connectorConfig,
        });
        if (existingIndex >= 0) {
            modules.items.splice(existingIndex, 1, nextNode);
        }
        else {
            modules.add(nextNode);
        }
    }
    fs.writeFileSync(HOMESERVER_YAML, String(doc), 'utf-8');
}
function verifyConnectorConfigured(config) {
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
async function restartSynapseIfRequested(shouldRestart) {
    if (!shouldRestart)
        return;
    if (!fs.existsSync(compose_js_1.COMPOSE_PATH)) {
        throw new Error(`docker-compose.yml fehlt fuer Connector-Restart: ${compose_js_1.COMPOSE_PATH}`);
    }
    await (0, safe_exec_js_1.dockerCompose)(compose_js_1.COMPOSE_PATH, ['up', '-d', 'synapse'], { timeout: 120_000 });
}
async function ensureMatrixConnectorInstalled(config, options = {}) {
    const connector = getEnabledConnector(config);
    upsertConnectorModule(config);
    if (!connector) {
        if (options.refreshCompose) {
            (0, compose_js_1.writeComposeFile)(config);
        }
        verifyConnectorConfigured(config);
        return { changed: false, message: 'Connector ist fuer diesen Tenant nicht aktiviert' };
    }
    if (connector.packageUrl) {
        await ensureArtifactExtracted(connector.packageUrl, connector.config.sharedSecret);
    }
    else {
        await ensureGitCheckout(connector.packageRepo || CONNECTOR_PACKAGE_REPO, connector.packageRef || 'main');
    }
    verifyCheckout();
    upsertConnectorModule(config);
    if (options.refreshCompose) {
        (0, compose_js_1.writeComposeFile)(config);
    }
    verifyConnectorConfigured(config);
    await restartSynapseIfRequested(Boolean(options.restartSynapse));
    return {
        changed: true,
        message: `Connector ${connector.moduleName} vorbereitet (${compose_js_1.CONNECTOR_HOST_DIR})`,
    };
}
function verifyMatrixConnectorInstalled(config) {
    const connector = getEnabledConnector(config);
    if (connector) {
        verifyCheckout();
    }
    verifyConnectorConfigured(config);
}
