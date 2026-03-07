/**
 * provision/steps/05-get-ssl.ts
 *
 * Step 5: SSL-Zertifikate via Certbot holen.
 *
 * Holt Zertifikate für matrixDomain UND webappDomain.
 * Nginx muss bereits laufen und auf Port 80 erreichbar sein (Step 1).
 * DNS muss bereits propagiert sein (setzt Backend beim Provisionieren).
 *
 * Idempotenz: Prüft ob Zertifikat bereits vorhanden.
 *             Certbot --keep-until-expiring verhindert unnötige Neuausstellung.
 */

import { exec }      from 'child_process';
import { promisify } from 'util';
import * as fs        from 'fs';
import { ProvisionConfig } from '../types.js';
import { logger }          from '../../utils/logger.js';

const execAsync = promisify(exec);

// ─── Idempotenz-Check ─────────────────────────────────────────────────────────

function certExists(domain: string): boolean {
  const certPath = `/etc/letsencrypt/live/${domain}/fullchain.pem`;
  return fs.existsSync(certPath);
}

// ─── DNS Propagation Check ────────────────────────────────────────────────────
// Wartet bis die Domain auflösbar ist — verhindert "No valid IP" Fehler bei Certbot.

async function waitForDns(domain: string, maxWaitMs = 120_000): Promise<void> {
  const start = Date.now();
  const interval = 10_000;

  logger.info(`[Step 5] Warte auf DNS-Propagation für ${domain}...`);

  while (Date.now() - start < maxWaitMs) {
    try {
      const { stdout } = await execAsync(`dig +short ${domain}`, { timeout: 10_000 });
      const ip = stdout.trim();
      if (ip && ip.match(/^\d+\.\d+\.\d+\.\d+$/)) {
        logger.info(`[Step 5] DNS für ${domain} aufgelöst: ${ip}`);
        return;
      }
    } catch {
      // dig nicht verfügbar? host versuchen
      try {
        const { stdout } = await execAsync(`host ${domain}`, { timeout: 10_000 });
        if (stdout.includes('has address')) {
          logger.info(`[Step 5] DNS für ${domain} aufgelöst`);
          return;
        }
      } catch {}
    }

    logger.info(`[Step 5] DNS noch nicht propagiert — warte ${interval / 1000}s...`);
    await new Promise(resolve => setTimeout(resolve, interval));
  }

  // Nicht fatal werfen — Certbot gibt eine klarere Fehlermeldung
  logger.warn(`[Step 5] DNS-Propagation für ${domain} unklar — versuche trotzdem Certbot`);
}

// ─── Step ─────────────────────────────────────────────────────────────────────

export async function stepGetSsl(cfg: ProvisionConfig): Promise<void> {
  const domains = [cfg.matrixDomain, cfg.webappDomain];

  // ── Idempotenz: beide Zertifikate vorhanden? ──────────────────────
  const allExist = domains.every(certExists);
  if (allExist) {
    logger.info('[Step 5] SSL-Zertifikate bereits vorhanden — überspringe');
    return;
  }

  // ── DNS-Propagation abwarten ──────────────────────────────────────
  for (const domain of domains) {
    if (!certExists(domain)) {
      await waitForDns(domain);
    }
  }

  // ── Certbot für jede Domain ───────────────────────────────────────
  // Getrennte Aufrufe: falls eine Domain scheitert, bekommt die andere
  // trotzdem ihr Zertifikat. Fehler werden gesammelt und am Ende geworfen.

  const errors: string[] = [];

  for (const domain of domains) {
    if (certExists(domain)) {
      logger.info(`[Step 5] Zertifikat für ${domain} bereits vorhanden — überspringe`);
      continue;
    }

    logger.info(`[Step 5] Hole Zertifikat für ${domain}...`);

    const certbotCmd = [
      'certbot certonly',
      '--nginx',
      '--non-interactive',
      '--agree-tos',
      '--email admin@prilog.chat',
      `--domain ${domain}`,
      '--keep-until-expiring',   // Idempotent: erneuert nur wenn nötig
      '--quiet',
    ].join(' ');

    try {
      const { stdout, stderr } = await execAsync(certbotCmd, { timeout: 120_000 });
      logger.info(`[Step 5] Zertifikat für ${domain} erhalten`);
      if (stderr) logger.info(`[Step 5] certbot stderr: ${stderr}`);
    } catch (err: any) {
      const msg = err?.stderr || err?.message || String(err);
      logger.error(`[Step 5] Certbot Fehler für ${domain}: ${msg}`);
      errors.push(`${domain}: ${msg}`);
    }
  }

  if (errors.length > 0) {
    throw new Error(`SSL-Fehler:\n${errors.join('\n')}`);
  }

  logger.info('[Step 5] Alle SSL-Zertifikate erhalten');
}
