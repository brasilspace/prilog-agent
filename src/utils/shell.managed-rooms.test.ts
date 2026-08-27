/**
 * managed_rooms.status — liest den Modulblock, mehr nicht.
 *
 * Der Waechter, der darauf aufsetzt, ist nur so gut wie diese Antwort. Vor
 * allem duerfen sich „Modul nicht eingetragen" und „Datei nicht lesbar" nicht
 * vermischen: sonst meldet der Waechter Entwarnung, wo er in Wahrheit nichts
 * weiss.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { executeCommand } from './shell.js';

const MIT_MODUL = `
server_name: "testschule.prilog.team"

modules:
  - module: prilog_matrix_connector.module.PrilogMatrixConnectorModule
    config:
      tenant_key: testschule
  - module: synapse_managed_rooms.ManagedRoomsModule
    config:
      deny: ["create_room", "invite"]
      exempt:
        - match: "@(admin|noreply):testschule\\\\.prilog\\\\.team"
          allow: ["create_room", "invite"]
      allow_direct_messages: true
      allow_invited_joins: true
`;

let root: string;

function box(slug: string, inhalt: string) {
  const dir = path.join(root, slug);
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, 'homeserver.yaml'), inhalt);
}

async function status(slug: string) {
  const r = await executeCommand('managed_rooms.status' as never, { slug } as never);
  return { success: r.success, data: JSON.parse(r.output) };
}

beforeEach(() => {
  root = mkdtempSync(path.join(tmpdir(), 'mr-status-'));
  process.env.PRILOG_TENANTS_ROOT = root;
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
  delete process.env.PRILOG_TENANTS_ROOT;
});

describe('managed_rooms.status', () => {
  it('liefert den Modulblock samt exempt-Muster', async () => {
    box('mitmodul', MIT_MODUL);
    const { success, data } = await status('mitmodul');
    expect(success).toBe(true);
    expect(data.present).toBe(true);
    // Der Backslash muss die Reise durch YAML unbeschadet ueberstehen —
    // sonst vergleicht der Waechter zwei verschiedene Ausdruecke.
    expect(data.config.exempt[0].match).toBe('@(admin|noreply):testschule\\.prilog\\.team');
    expect(data.config.allow_invited_joins).toBe(true);
    expect(data.config.deny).toEqual(['create_room', 'invite']);
  });

  it('meldet present:false, wenn die Datei da ist, das Modul aber fehlt', async () => {
    box('ohnemodul', 'server_name: "x"\nmodules: []\n');
    const { success, data } = await status('ohnemodul');
    expect(success).toBe(true);
    expect(data.present).toBe(false);
    expect(data.config).toBeNull();
  });

  it('meldet present:false auch ohne modules-Block', async () => {
    box('garnichts', 'server_name: "x"\n');
    const { success, data } = await status('garnichts');
    expect(success).toBe(true);
    expect(data.present).toBe(false);
  });

  it('unterscheidet "nicht lesbar" klar von "nicht vorhanden"', async () => {
    const { success, data } = await status('gibtesnicht');
    expect(success).toBe(false);
    expect(data.error).toContain('nicht gefunden');
    // Entscheidend: KEIN present-Feld, das mit false verwechselt werden koennte.
    expect(data.present).toBeUndefined();
  });

  it('faellt bei kaputtem YAML nicht auf present:false zurueck', async () => {
    box('kaputt', 'modules:\n  - module: [unbalanced\n');
    const { success, data } = await status('kaputt');
    expect(success).toBe(false);
    expect(data.present).toBeUndefined();
  });
});
