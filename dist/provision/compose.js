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
exports.CONNECTOR_CONTAINER_DIR = exports.CONNECTOR_HOST_DIR = exports.COMPOSE_PATH = exports.COMPOSE_DIR = void 0;
exports.buildComposeContent = buildComposeContent;
exports.writeComposeFile = writeComposeFile;
const fs = __importStar(require("fs"));
exports.COMPOSE_DIR = '/opt/prilog';
exports.COMPOSE_PATH = `${exports.COMPOSE_DIR}/docker-compose.yml`;
exports.CONNECTOR_HOST_DIR = '/opt/prilog/connectors/prilog-matrix-connector';
exports.CONNECTOR_CONTAINER_DIR = '/modules/prilog-matrix-connector';
function buildSynapsePortBinding(cfg) {
    const bindAddress = (cfg.synapseBindAddress || '0.0.0.0').trim();
    return bindAddress === '0.0.0.0' ? '8008:8008' : `${bindAddress}:8008:8008`;
}
function buildSynapseEnvironment(cfg) {
    const environment = [
        `      SYNAPSE_SERVER_NAME: ${cfg.matrixDomain}`,
        '      SYNAPSE_REPORT_STATS: "no"',
    ];
    if (cfg.synapseModules?.connector?.enabled) {
        environment.push(`      PYTHONPATH: ${exports.CONNECTOR_CONTAINER_DIR}/src`);
    }
    return environment;
}
function buildSynapseVolumes(cfg) {
    const volumes = ['      - /mnt/prilog-data/synapse:/data'];
    if (cfg.synapseModules?.connector?.enabled) {
        volumes.push(`      - ${exports.CONNECTOR_HOST_DIR}:${exports.CONNECTOR_CONTAINER_DIR}:ro`);
    }
    return volumes;
}
function buildComposeContent(cfg) {
    const synapseEnvironment = buildSynapseEnvironment(cfg).join('\n');
    const synapseVolumes = buildSynapseVolumes(cfg).join('\n');
    const synapsePortBinding = buildSynapsePortBinding(cfg);
    return `version: '3.8'

services:
  postgres:
    image: postgres:15-alpine
    restart: unless-stopped
    environment:
      POSTGRES_DB: synapse
      POSTGRES_USER: synapse
      POSTGRES_PASSWORD: ${cfg.dbPassword}
      POSTGRES_INITDB_ARGS: "--encoding=UTF-8 --lc-collate=C --lc-ctype=C"
    volumes:
      - /mnt/prilog-data/postgres:/var/lib/postgresql/data
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U synapse"]
      interval: 10s
      timeout: 5s
      retries: 5
      start_period: 20s

  synapse:
    image: matrixdotorg/synapse:latest
    restart: unless-stopped
    depends_on:
      postgres:
        condition: service_healthy
    environment:
${synapseEnvironment}
    volumes:
${synapseVolumes}
    ports:
      - "${synapsePortBinding}"

    healthcheck:
      test: ["CMD-SHELL", "curl -sf http://localhost:8008/_matrix/client/versions || exit 1"]
      interval: 15s
      timeout: 10s
      retries: 10
      start_period: 60s

networks:
  default:
    name: prilog-${cfg.subdomain}
`;
}
function writeComposeFile(cfg) {
    fs.mkdirSync(exports.COMPOSE_DIR, { recursive: true });
    const content = buildComposeContent(cfg);
    fs.writeFileSync(exports.COMPOSE_PATH, content, 'utf-8');
    return exports.COMPOSE_PATH;
}
