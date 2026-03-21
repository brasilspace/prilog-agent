import * as fs from 'fs';

import { ProvisionConfig } from './types.js';

export const COMPOSE_DIR = '/opt/prilog';
export const COMPOSE_PATH = `${COMPOSE_DIR}/docker-compose.yml`;
export const CONNECTOR_HOST_DIR = '/opt/synapse/connectors/prilog-matrix-connector';
export const CONNECTOR_CONTAINER_DIR = '/modules/prilog-matrix-connector';

function buildSynapsePortBinding(cfg: ProvisionConfig): string {
  const bindAddress = (cfg.synapseBindAddress || '0.0.0.0').trim();
  return bindAddress === '0.0.0.0' ? '8008:8008' : `${bindAddress}:8008:8008`;
}

function buildSynapseEnvironment(cfg: ProvisionConfig): string[] {
  const environment = [
    `      SYNAPSE_SERVER_NAME: ${cfg.matrixDomain}`,
    '      SYNAPSE_REPORT_STATS: "no"',
  ];

  if (cfg.synapseModules?.connector?.enabled) {
    environment.push(`      PYTHONPATH: ${CONNECTOR_CONTAINER_DIR}/src`);
  }

  return environment;
}

function buildSynapseVolumes(cfg: ProvisionConfig): string[] {
  const volumes = ['      - /mnt/prilog-data/synapse:/data'];

  if (cfg.synapseModules?.connector?.enabled) {
    volumes.push(`      - ${CONNECTOR_HOST_DIR}:${CONNECTOR_CONTAINER_DIR}:ro`);
  }

  return volumes;
}

export function buildComposeContent(cfg: ProvisionConfig): string {
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

export function writeComposeFile(cfg: ProvisionConfig): string {
  fs.mkdirSync(COMPOSE_DIR, { recursive: true });
  const content = buildComposeContent(cfg);
  fs.writeFileSync(COMPOSE_PATH, content, 'utf-8');
  return COMPOSE_PATH;
}
