/**
 * provision/runner.ts
 *
 * Orchestriert alle Provisioning-Steps sequenziell.
 *
 * Features:
 *  - Jeden Step sauber reporten (running → success | error)
 *  - Bei Fehler sofort stoppen — kein blindes Weiterlaufen
 *  - startFromStep: Steps davor werden als "skipped" übersprungen
 *  - Steps sind idempotent — sicheres Re-Run
 *
 * Verwendung:
 *   const results = await runProvision(config, report, startFromStep?);
 */

import {
  ProvisionConfig,
  StepDefinition,
  StepName,
  StepResult,
  STEP_NAMES,
  ReportFn,
} from './types.js';
import { logger } from '../utils/logger.js';

// ─── Steps importieren ────────────────────────────────────────────────────────

import { stepInstallNginx }       from './steps/01-install-nginx.js';
import { stepGenerateSynapse }    from './steps/02-generate-synapse.js';
import { stepWriteCompose }       from './steps/03-write-compose.js';
import { stepStartContainers }    from './steps/04-start-containers.js';
import { stepGetSsl }             from './steps/05-get-ssl.js';
import { stepConfigureNginxSsl }  from './steps/06-configure-nginx-ssl.js';
import { stepCreateAdminUser }    from './steps/07-create-admin-user.js';
import { stepFinalize }           from './steps/08-finalize.js';

// ─── Step Registry ────────────────────────────────────────────────────────────

const STEPS: StepDefinition[] = [
  { name: 'install_nginx',       fn: stepInstallNginx      },
  { name: 'generate_synapse',    fn: stepGenerateSynapse   },
  { name: 'write_compose',       fn: stepWriteCompose      },
  { name: 'start_containers',    fn: stepStartContainers   },
  { name: 'get_ssl',             fn: stepGetSsl            },
  { name: 'configure_nginx_ssl', fn: stepConfigureNginxSsl },
  { name: 'create_admin_user',   fn: stepCreateAdminUser   },
  { name: 'finalize',            fn: stepFinalize          },
];

// ─── Runner ───────────────────────────────────────────────────────────────────

/**
 * Führt alle Provisioning-Steps aus.
 *
 * @param config        - Server-Konfiguration (Secrets, Domains etc.)
 * @param report        - Callback für Step-Status (an Backend melden)
 * @param startFromStep - Optional: ab welchem Step starten? (für Retry)
 * @returns             - Array aller Step-Ergebnisse
 */
export async function runProvision(
  config:          ProvisionConfig,
  report:          ReportFn,
  startFromStep?:  StepName,
): Promise<StepResult[]> {
  const results: StepResult[] = [];

  // Startindex ermitteln (0 = von vorne, sonst ab dem Step)
  const startIndex = startFromStep
    ? STEPS.findIndex(s => s.name === startFromStep)
    : 0;

  if (startFromStep && startIndex === -1) {
    logger.error(`[Provision] Unbekannter startFromStep: ${startFromStep}`);
    throw new Error(`Unbekannter startFromStep: ${startFromStep}`);
  }

  logger.info(`[Provision] Starte Provisioning für ${config.subdomain}` +
    (startFromStep ? ` (ab Step: ${startFromStep})` : ''));

  for (let i = 0; i < STEPS.length; i++) {
    const { name, fn } = STEPS[i];

    // Steps vor startFromStep überspringen
    if (i < startIndex) {
      logger.info(`[Provision] Überspringe ${name} (vor startFromStep)`);
      results.push({ step: name, status: 'skipped', duration: 0 });
      continue;
    }

    // Step ausführen
    const stepStart = Date.now();
    report(name, 'running');

    try {
      await fn(config);

      const duration = Date.now() - stepStart;
      report(name, 'success');
      results.push({ step: name, status: 'success', duration });
      logger.info(`[Provision] ✅ ${name} erfolgreich (${duration}ms)`);

    } catch (err: unknown) {
      const duration = Date.now() - stepStart;
      const message  = err instanceof Error ? err.message : String(err);

      report(name, 'error', message);
      results.push({ step: name, status: 'error', message, duration });
      logger.error(`[Provision] ❌ ${name} fehlgeschlagen (${duration}ms): ${message}`);

      // Sofort stoppen — kein Blindflug
      logger.info(`[Provision] Provisioning gestoppt nach Fehler in Step: ${name}`);
      break;
    }
  }

  const failed    = results.filter(r => r.status === 'error');
  const succeeded = results.filter(r => r.status === 'success');
  logger.info(`[Provision] Abgeschlossen: ${succeeded.length} OK, ${failed.length} Fehler`);

  return results;
}
