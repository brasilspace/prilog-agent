/**
 * provision/runner.ts
 *
 * Orchestriert alle 12 Provisioning-Steps sequenziell.
 */

import {
  ProvisionConfig,
  StepDefinition,
  StepName,
  StepResult,
  ReportFn,
} from './types.js';
import { logger } from '../utils/logger.js';

// ─── Steps importieren ────────────────────────────────────────────────────────

import { stepInstallDocker }      from './steps/01-install-docker.js';
import { stepConfigureFirewall }  from './steps/02-configure-firewall.js';
import { stepSetupTailscale }     from './steps/03-setup-tailscale.js';
import { stepMountVolume }        from './steps/04-mount-volume.js';
import { stepInstallNginx }       from './steps/05-install-nginx.js';
import { stepGenerateSynapse }    from './steps/06-generate-synapse.js';
import { stepWriteCompose }       from './steps/07-write-compose.js';
import { stepStartContainers }    from './steps/08-start-containers.js';
import { stepGetSsl }             from './steps/09-get-ssl.js';
import { stepConfigureNginxSsl }  from './steps/10-configure-nginx-ssl.js';
import { stepCreateAdminUser }    from './steps/11-create-admin-user.js';
import { stepFinalize }           from './steps/12-finalize.js';

// ─── Step Registry ────────────────────────────────────────────────────────────

const STEPS: StepDefinition[] = [
  { name: 'install_docker',      fn: stepInstallDocker     },
  { name: 'configure_firewall',  fn: stepConfigureFirewall },
  { name: 'setup_tailscale',     fn: stepSetupTailscale    },
  { name: 'mount_volume',        fn: stepMountVolume       },
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

export async function runProvision(
  config:         ProvisionConfig,
  report:         ReportFn,
  startFromStep?: StepName,
): Promise<StepResult[]> {
  const results: StepResult[] = [];

  const startIndex = startFromStep
    ? STEPS.findIndex(s => s.name === startFromStep)
    : 0;

  if (startFromStep && startIndex === -1) {
    throw new Error(`Unbekannter startFromStep: ${startFromStep}`);
  }

  logger.info(`[Provision] Starte für ${config.subdomain}` +
    (startFromStep ? ` (ab Step: ${startFromStep})` : ''));

  for (let i = 0; i < STEPS.length; i++) {
    const { name, fn } = STEPS[i];

    if (i < startIndex) {
      logger.info(`[Provision] Überspringe ${name}`);
      results.push({ step: name, status: 'skipped', duration: 0 });
      continue;
    }

    const stepStart = Date.now();
    report(name, 'running');

    try {
      await fn(config);
      const duration = Date.now() - stepStart;
      report(name, 'success');
      results.push({ step: name, status: 'success', duration });
      logger.info(`[Provision] ✅ ${name} (${duration}ms)`);

    } catch (err: unknown) {
      const duration = Date.now() - stepStart;
      const message  = err instanceof Error ? err.message : String(err);
      report(name, 'error', message);
      results.push({ step: name, status: 'error', message, duration });
      logger.error(`[Provision] ❌ ${name} (${duration}ms): ${message}`);
      break;
    }
  }

  const failed    = results.filter(r => r.status === 'error');
  const succeeded = results.filter(r => r.status === 'success');
  logger.info(`[Provision] Abgeschlossen: ${succeeded.length} OK, ${failed.length} Fehler`);

  return results;
}
