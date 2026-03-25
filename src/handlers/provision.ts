/**
 * handlers/provision.ts
 *
 * Empfängt den "provision"-Befehl vom Backend und startet den Step-Runner.
 *
 * Wird von agent.ts aufgerufen wenn:
 *   msg.type === 'server.command' && cmd.command === 'provision'
 *
 * Das Backend sendet:
 *   { command: "provision", args: { config: {...}, startFromStep?: "..." } }
 *
 * Der Handler:
 *   1. Liest ProvisionConfig aus den args
 *   2. Validiert mit Zod-Schema
 *   3. Erstellt einen Reporter (meldet Steps via WebSocket)
 *   4. Startet den Runner
 *   5. Gibt Ergebnis via agent.command_result zurück
 */

import { ProvisionConfig, StepName } from '../provision/types.js';
import { createReporter }                               from '../provision/reporter.js';
import { runProvision }                                 from '../provision/runner.js';
import { validateProvisionConfig }                      from '../provision/engine/config-validator.js';
import { logger }                                       from '../utils/logger.js';

// ─── Send Function Type ───────────────────────────────────────────────────────

type SendFn = (type: string, payload: unknown) => boolean;

// ─── Handler ──────────────────────────────────────────────────────────────────

export async function handleProvisionCommand(
  commandId: string,
  args:       Record<string, unknown>,
  send:       SendFn,
): Promise<void> {
  const start = Date.now();

  // ── Config validieren ─────────────────────────────────────────────
  const rawConfig = args?.config;

  if (!rawConfig) {
    logger.error('[ProvisionHandler] Kein config-Objekt in den args');
    send('agent.command_result', {
      commandId,
      success: false,
      output: 'Provision-Befehl ohne config — Programmfehler im Backend',
      duration: Date.now() - start,
    });
    return;
  }

  // Zod-basierte Validierung
  let config: ProvisionConfig;
  try {
    config = validateProvisionConfig(rawConfig) as unknown as ProvisionConfig;
  } catch (err: any) {
    const message = err?.issues
      ? err.issues.map((i: any) => `${i.path.join('.')}: ${i.message}`).join(', ')
      : (err?.message ?? String(err));
    logger.error(`[ProvisionHandler] Config-Validierung fehlgeschlagen: ${message}`);
    send('agent.command_result', {
      commandId,
      success: false,
      output: `Config-Validierung fehlgeschlagen: ${message}`,
      duration: Date.now() - start,
    });
    return;
  }

  const startFromStep = args?.startFromStep as StepName | undefined;

  logger.info(
    `[ProvisionHandler] Starte Provisioning für ${config.subdomain}` +
    (startFromStep ? ` ab Step: ${startFromStep}` : '')
  );

  // ── Reporter erstellen ────────────────────────────────────────────
  const report = createReporter(send, config.orderId);

  // ── Runner starten ────────────────────────────────────────────────
  try {
    const results = await runProvision(config, report, startFromStep);

    const allSuccess = results.every(r => r.status !== 'error');
    const failedStep = results.find(r => r.status === 'error');

    send('agent.command_result', {
      commandId,
      success:  allSuccess,
      output:   allSuccess
        ? `Provisioning abgeschlossen (${results.filter(r => r.status === 'success').length} Steps)`
        : `Provisioning gestoppt bei Step: ${failedStep?.step} — ${failedStep?.message}`,
      duration: Date.now() - start,
    });

  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    logger.error(`[ProvisionHandler] Runner-Fehler: ${message}`);

    send('agent.command_result', {
      commandId,
      success: false,
      output:  `Provision-Runner Fehler: ${message}`,
      duration: Date.now() - start,
    });
  }
}
