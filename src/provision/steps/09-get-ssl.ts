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

import * as fs        from 'fs';
import { ProvisionConfig } from '../types.js';
import { logger }          from '../../utils/logger.js';
import { safeExec }        from '../engine/safe-exec.js';

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
      const result = await safeExec('dig', ['+short', domain], { timeout: 10_000, ignoreExitCode: true });
      const ip = result.stdout.trim();
      if (ip && ip.match(/^\d+\.\d+\.\d+\.\d+$/)) {
        logger.info(`[Step 5] DNS für ${domain} aufgelöst: ${ip}`);
        return;
      }
    } catch {
      // dig nicht verfügbar? host versuchen
      try {
        const result = await safeExec('host', [domain], { timeout: 10_000, ignoreExitCode: true });
        if (result.stdout.includes('has address')) {
          logger.info(`[Step 5] DNS für ${domain} aufgelöst`);
          return;
        }
      } catch { /* intentionally empty */ }
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

    try {
      const result = await safeExec('certbot', [
        'certonly',
        '--nginx',
        '--non-interactive',
        '--agree-tos',
        '--email', 'admin@prilog.chat',
        '--domain', domain,
        '--keep-until-expiring',
        '--quiet',
      ], { timeout: 120_000 });
      logger.info(`[Step 5] Zertifikat für ${domain} erhalten`);
      if (result.stderr) logger.info(`[Step 5] certbot stderr: ${result.stderr}`);
    } catch (err: any) {
      const msg = err?.message || String(err);
      logger.error(`[Step 5] Certbot Fehler für ${domain}: ${msg}`);
      errors.push(`${domain}: ${msg}`);
    }
  }

  if (errors.length > 0) {
    throw new Error(`SSL-Fehler:\n${errors.join('\n')}`);
  }

  logger.info('[Step 5] Alle SSL-Zertifikate erhalten');
}

export async function verifyGetSsl(cfg: ProvisionConfig): Promise<void> {
  const domains = [cfg.matrixDomain, cfg.webappDomain];
  for (const domain of domains) {
    if (!fs.existsSync(`/etc/letsencrypt/live/${domain}/fullchain.pem`) ||
        !fs.existsSync(`/etc/letsencrypt/live/${domain}/privkey.pem`)) {
      throw new Error(`SSL-Zertifikat für ${domain} fehlt nach Certbot`);
    }
  }
}
