/**
 * provision/runner.ts
 *
 * Orchestriert alle 12 Provisioning-Steps sequenziell.
 * Nach jedem Step wird verify() aufgerufen — schlägt er fehl, stoppt der Runner.
 */

import {
  ProvisionConfig,
  StepName,
  StepResult,
  ReportFn,
} from './types.js';
import { logger } from '../utils/logger.js';
import { validateProvisionConfig } from './engine/config-validator.js';
import { StepRegistry } from './engine/step-registry.js';

// ─── Steps importieren ────────────────────────────────────────────────────────

import { stepInstallDocker,     verifyInstallDocker     } from './steps/01-install-docker.js';
import { stepConfigureFirewall, verifyConfigureFirewall } from './steps/02-configure-firewall.js';
import { stepSetupTailscale,    verifySetupTailscale    } from './steps/03-setup-tailscale.js';
import { stepMountVolume,       verifyMountVolume       } from './steps/04-mount-volume.js';
import { stepInstallNginx,      verifyInstallNginx      } from './steps/05-install-nginx.js';
import { stepGenerateSynapse,   verifyGenerateSynapse   } from './steps/06-generate-synapse.js';
import { stepInstallMatrixConnector, verifyInstallMatrixConnector } from './steps/06b-install-matrix-connector.js';
import { stepWriteCompose,      verifyWriteCompose      } from './steps/07-write-compose.js';
import { stepStartContainers,   verifyStartContainers   } from './steps/08-start-containers.js';
import { stepGetSsl,            verifyGetSsl            } from './steps/09-get-ssl.js';
import { stepConfigureNginxSsl, verifyConfigureNginxSsl } from './steps/10-configure-nginx-ssl.js';
import { stepCreateAdminUser,   verifyCreateAdminUser   } from './steps/11-create-admin-user.js';
import { stepFinalize,          verifyFinalize          } from './steps/12-finalize.js';

// ─── Step Registry ────────────────────────────────────────────────────────────

const registry = new StepRegistry();
registry.register({ name: 'install_docker',          fn: stepInstallDocker,          verify: verifyInstallDocker      });
registry.register({ name: 'configure_firewall',      fn: stepConfigureFirewall,      verify: verifyConfigureFirewall  });
registry.register({ name: 'setup_tailscale',         fn: stepSetupTailscale,         verify: verifySetupTailscale     });
registry.register({ name: 'mount_volume',            fn: stepMountVolume,            verify: verifyMountVolume        });
registry.register({ name: 'install_nginx',           fn: stepInstallNginx,           verify: verifyInstallNginx       });
registry.register({ name: 'generate_synapse',        fn: stepGenerateSynapse,        verify: verifyGenerateSynapse    });
registry.register({ name: 'install_matrix_connector', fn: stepInstallMatrixConnector, verify: verifyInstallMatrixConnector });
registry.register({ name: 'write_compose',           fn: stepWriteCompose,           verify: verifyWriteCompose       });
registry.register({ name: 'start_containers',        fn: stepStartContainers,        verify: verifyStartContainers    });
registry.register({ name: 'get_ssl',                 fn: stepGetSsl,                 verify: verifyGetSsl             });
registry.register({ name: 'configure_nginx_ssl',     fn: stepConfigureNginxSsl,      verify: verifyConfigureNginxSsl  });
registry.register({ name: 'create_admin_user',       fn: stepCreateAdminUser,        verify: verifyCreateAdminUser    });
registry.register({ name: 'finalize',                fn: stepFinalize,               verify: verifyFinalize           });

// ─── Runner ───────────────────────────────────────────────────────────────────

export async function runProvision(
  config:         ProvisionConfig,
  report:         ReportFn,
  startFromStep?: StepName,
): Promise<StepResult[]> {
  // ── Config validieren ─────────────────────────────────────────────
  validateProvisionConfig(config);

  const results: StepResult[] = [];
  const STEPS = registry.getAll();

  const startIndex = startFromStep
    ? registry.findIndex(startFromStep)
    : 0;

  if (startFromStep && startIndex === -1) {
    throw new Error(`Unbekannter startFromStep: ${startFromStep}`);
  }

  logger.info(`[Provision] Starte für ${config.subdomain}` +
    (startFromStep ? ` (ab Step: ${startFromStep})` : ''));

  for (let i = 0; i < STEPS.length; i++) {
    const { name, fn, verify } = STEPS[i];

    if (i < startIndex) {
      logger.info(`[Provision] Überspringe ${name}`);
      results.push({ step: name, status: 'skipped', duration: 0 });
      continue;
    }

    const stepStart = Date.now();
    report(name, 'running');

    try {
      // ── Step ausführen ───────────────────────────────────────────
      await fn(config);
      logger.info(`[Provision] ${name} ausgeführt — verifiziere...`);

      // ── Verifizieren ─────────────────────────────────────────────
      await verify(config);

      const duration = Date.now() - stepStart;
      report(name, 'success');
      results.push({ step: name, status: 'success', duration });
      logger.info(`[Provision] ${name} verifiziert (${duration}ms)`);

    } catch (err: unknown) {
      const duration = Date.now() - stepStart;
      const message  = err instanceof Error ? err.message : String(err);
      report(name, 'error', message);
      results.push({ step: name, status: 'error', message, duration });
      logger.error(`[Provision] ${name} (${duration}ms): ${message}`);
      break; // Kein nächster Step
    }
  }

  const failed    = results.filter(r => r.status === 'error');
  const succeeded = results.filter(r => r.status === 'success');
  logger.info(`[Provision] Abgeschlossen: ${succeeded.length} OK, ${failed.length} Fehler`);

  return results;
}
