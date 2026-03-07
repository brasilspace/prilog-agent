/**
 * provision/steps/03-write-compose.ts
 *
 * Step 3: docker-compose.yml für Synapse + PostgreSQL schreiben.
 *
 * Idempotenz: Immer überschreiben — gleiche Config ergibt gleiche Datei.
 *             docker compose up -d ist ebenfalls idempotent.
 */

import * as fs        from 'fs';
import { ProvisionConfig } from '../types.js';
import { logger }          from '../../utils/logger.js';

const COMPOSE_DIR  = '/opt/prilog';
const COMPOSE_PATH = `${COMPOSE_DIR}/docker-compose.yml`;

// ─── Docker Compose Template ──────────────────────────────────────────────────

function buildComposeContent(cfg: ProvisionConfig): string {
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
      SYNAPSE_SERVER_NAME: ${cfg.matrixDomain}
      SYNAPSE_REPORT_STATS: "no"
    volumes:
      - /mnt/prilog-data/synapse:/data
    ports:
      - "127.0.0.1:8008:8008"
      - "8448:8448"
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

// ─── Step ─────────────────────────────────────────────────────────────────────

export async function stepWriteCompose(cfg: ProvisionConfig): Promise<void> {
  fs.mkdirSync(COMPOSE_DIR, { recursive: true });

  const content = buildComposeContent(cfg);
  fs.writeFileSync(COMPOSE_PATH, content, 'utf-8');

  logger.info(`[Step 3] docker-compose.yml geschrieben: ${COMPOSE_PATH}`);
}
