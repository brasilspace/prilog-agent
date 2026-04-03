"use strict";
/**
 * provision/runner.ts
 *
 * Orchestriert alle 12 Provisioning-Steps sequenziell.
 * Nach jedem Step wird verify() aufgerufen — schlägt er fehl, stoppt der Runner.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.runProvision = runProvision;
const logger_js_1 = require("../utils/logger.js");
const config_validator_js_1 = require("./engine/config-validator.js");
const step_registry_js_1 = require("./engine/step-registry.js");
// ─── Steps importieren ────────────────────────────────────────────────────────
const _01_install_docker_js_1 = require("./steps/01-install-docker.js");
const _02_configure_firewall_js_1 = require("./steps/02-configure-firewall.js");
const _03_setup_tailscale_js_1 = require("./steps/03-setup-tailscale.js");
const _04_mount_volume_js_1 = require("./steps/04-mount-volume.js");
const _05_install_nginx_js_1 = require("./steps/05-install-nginx.js");
const _06_generate_synapse_js_1 = require("./steps/06-generate-synapse.js");
const _06b_install_matrix_connector_js_1 = require("./steps/06b-install-matrix-connector.js");
const _06c_deploy_web_client_js_1 = require("./steps/06c-deploy-web-client.js");
const _07_write_compose_js_1 = require("./steps/07-write-compose.js");
const _08_start_containers_js_1 = require("./steps/08-start-containers.js");
const _09_get_ssl_js_1 = require("./steps/09-get-ssl.js");
const _10_configure_nginx_ssl_js_1 = require("./steps/10-configure-nginx-ssl.js");
const _11_create_admin_user_js_1 = require("./steps/11-create-admin-user.js");
const _12_finalize_js_1 = require("./steps/12-finalize.js");
// ─── Step Registry ────────────────────────────────────────────────────────────
const registry = new step_registry_js_1.StepRegistry();
registry.register({ name: 'install_docker', fn: _01_install_docker_js_1.stepInstallDocker, verify: _01_install_docker_js_1.verifyInstallDocker });
registry.register({ name: 'configure_firewall', fn: _02_configure_firewall_js_1.stepConfigureFirewall, verify: _02_configure_firewall_js_1.verifyConfigureFirewall });
registry.register({ name: 'setup_tailscale', fn: _03_setup_tailscale_js_1.stepSetupTailscale, verify: _03_setup_tailscale_js_1.verifySetupTailscale });
registry.register({ name: 'mount_volume', fn: _04_mount_volume_js_1.stepMountVolume, verify: _04_mount_volume_js_1.verifyMountVolume });
registry.register({ name: 'install_nginx', fn: _05_install_nginx_js_1.stepInstallNginx, verify: _05_install_nginx_js_1.verifyInstallNginx });
registry.register({ name: 'generate_synapse', fn: _06_generate_synapse_js_1.stepGenerateSynapse, verify: _06_generate_synapse_js_1.verifyGenerateSynapse });
registry.register({ name: 'install_matrix_connector', fn: _06b_install_matrix_connector_js_1.stepInstallMatrixConnector, verify: _06b_install_matrix_connector_js_1.verifyInstallMatrixConnector });
registry.register({ name: 'deploy_web_client', fn: _06c_deploy_web_client_js_1.stepDeployWebClient, verify: _06c_deploy_web_client_js_1.verifyDeployWebClient });
registry.register({ name: 'write_compose', fn: _07_write_compose_js_1.stepWriteCompose, verify: _07_write_compose_js_1.verifyWriteCompose });
registry.register({ name: 'start_containers', fn: _08_start_containers_js_1.stepStartContainers, verify: _08_start_containers_js_1.verifyStartContainers });
registry.register({ name: 'get_ssl', fn: _09_get_ssl_js_1.stepGetSsl, verify: _09_get_ssl_js_1.verifyGetSsl });
registry.register({ name: 'configure_nginx_ssl', fn: _10_configure_nginx_ssl_js_1.stepConfigureNginxSsl, verify: _10_configure_nginx_ssl_js_1.verifyConfigureNginxSsl });
registry.register({ name: 'create_admin_user', fn: _11_create_admin_user_js_1.stepCreateAdminUser, verify: _11_create_admin_user_js_1.verifyCreateAdminUser });
registry.register({ name: 'finalize', fn: _12_finalize_js_1.stepFinalize, verify: _12_finalize_js_1.verifyFinalize });
// ─── Runner ───────────────────────────────────────────────────────────────────
async function runProvision(config, report, startFromStep) {
    // ── Config validieren ─────────────────────────────────────────────
    (0, config_validator_js_1.validateProvisionConfig)(config);
    const results = [];
    const STEPS = registry.getAll();
    const startIndex = startFromStep
        ? registry.findIndex(startFromStep)
        : 0;
    if (startFromStep && startIndex === -1) {
        throw new Error(`Unbekannter startFromStep: ${startFromStep}`);
    }
    logger_js_1.logger.info(`[Provision] Starte für ${config.subdomain}` +
        (startFromStep ? ` (ab Step: ${startFromStep})` : ''));
    for (let i = 0; i < STEPS.length; i++) {
        const { name, fn, verify } = STEPS[i];
        if (i < startIndex) {
            logger_js_1.logger.info(`[Provision] Überspringe ${name}`);
            results.push({ step: name, status: 'skipped', duration: 0 });
            continue;
        }
        const stepStart = Date.now();
        report(name, 'running');
        try {
            // ── Step ausführen ───────────────────────────────────────────
            await fn(config);
            logger_js_1.logger.info(`[Provision] ${name} ausgeführt — verifiziere...`);
            // ── Verifizieren ─────────────────────────────────────────────
            await verify(config);
            const duration = Date.now() - stepStart;
            report(name, 'success');
            results.push({ step: name, status: 'success', duration });
            logger_js_1.logger.info(`[Provision] ${name} verifiziert (${duration}ms)`);
        }
        catch (err) {
            const duration = Date.now() - stepStart;
            const message = err instanceof Error ? err.message : String(err);
            report(name, 'error', message);
            results.push({ step: name, status: 'error', message, duration });
            logger_js_1.logger.error(`[Provision] ${name} (${duration}ms): ${message}`);
            break; // Kein nächster Step
        }
    }
    const failed = results.filter(r => r.status === 'error');
    const succeeded = results.filter(r => r.status === 'success');
    logger_js_1.logger.info(`[Provision] Abgeschlossen: ${succeeded.length} OK, ${failed.length} Fehler`);
    return results;
}
