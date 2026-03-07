/**
 * provision/reporter.ts
 *
 * Sendet Step-Status ans Backend via WebSocket.
 * Das Backend speichert den Status in der DB und streamt ihn ans Admin-Frontend.
 *
 * Protokoll (Agent → Backend):
 *   type: "agent.provision_step"
 *   payload: { orderId, step, status, message? }
 */

import { StepName, ReportFn } from './types.js';
import { logger } from '../utils/logger.js';

// ─── Send Function Type ───────────────────────────────────────────────────────
// Wird vom AgentTransport.send bereitgestellt.

type SendFn = (type: string, payload: unknown) => boolean;

// ─── Factory ──────────────────────────────────────────────────────────────────

/**
 * Erstellt eine ReportFn die über den übergebenen send-Kanal
 * Step-Status ans Backend meldet.
 */
export function createReporter(send: SendFn, orderId: string): ReportFn {
  return (step: StepName, status: 'running' | 'success' | 'error', message?: string) => {
    const payload = { orderId, step, status, message };

    logger.info(`[Provision] ${step} → ${status}${message ? ': ' + message : ''}`);

    const sent = send('agent.provision_step', payload);

    if (!sent) {
      // WebSocket kurzzeitig nicht verfügbar — nicht kritisch, weitermachen.
      // Backend erkennt fehlende Steps beim Reconnect.
      logger.warn(`[Provision] Reporter: Konnte Step-Status nicht senden (${step}/${status})`);
    }
  };
}
