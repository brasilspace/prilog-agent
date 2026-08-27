"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
/**
 * managed_rooms.status — liest den Modulblock, mehr nicht.
 *
 * Der Waechter, der darauf aufsetzt, ist nur so gut wie diese Antwort. Vor
 * allem duerfen sich „Modul nicht eingetragen" und „Datei nicht lesbar" nicht
 * vermischen: sonst meldet der Waechter Entwarnung, wo er in Wahrheit nichts
 * weiss.
 */
const vitest_1 = require("vitest");
const node_fs_1 = require("node:fs");
const node_os_1 = require("node:os");
const node_path_1 = __importDefault(require("node:path"));
const shell_js_1 = require("./shell.js");
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
let root;
function box(slug, inhalt) {
    const dir = node_path_1.default.join(root, slug);
    (0, node_fs_1.mkdirSync)(dir, { recursive: true });
    (0, node_fs_1.writeFileSync)(node_path_1.default.join(dir, 'homeserver.yaml'), inhalt);
}
async function status(slug) {
    const r = await (0, shell_js_1.executeCommand)('managed_rooms.status', { slug });
    return { success: r.success, data: JSON.parse(r.output) };
}
(0, vitest_1.beforeEach)(() => {
    root = (0, node_fs_1.mkdtempSync)(node_path_1.default.join((0, node_os_1.tmpdir)(), 'mr-status-'));
    process.env.PRILOG_TENANTS_ROOT = root;
});
(0, vitest_1.afterEach)(() => {
    (0, node_fs_1.rmSync)(root, { recursive: true, force: true });
    delete process.env.PRILOG_TENANTS_ROOT;
});
(0, vitest_1.describe)('managed_rooms.status', () => {
    (0, vitest_1.it)('liefert den Modulblock samt exempt-Muster', async () => {
        box('mitmodul', MIT_MODUL);
        const { success, data } = await status('mitmodul');
        (0, vitest_1.expect)(success).toBe(true);
        (0, vitest_1.expect)(data.present).toBe(true);
        // Der Backslash muss die Reise durch YAML unbeschadet ueberstehen —
        // sonst vergleicht der Waechter zwei verschiedene Ausdruecke.
        (0, vitest_1.expect)(data.config.exempt[0].match).toBe('@(admin|noreply):testschule\\.prilog\\.team');
        (0, vitest_1.expect)(data.config.allow_invited_joins).toBe(true);
        (0, vitest_1.expect)(data.config.deny).toEqual(['create_room', 'invite']);
    });
    (0, vitest_1.it)('meldet present:false, wenn die Datei da ist, das Modul aber fehlt', async () => {
        box('ohnemodul', 'server_name: "x"\nmodules: []\n');
        const { success, data } = await status('ohnemodul');
        (0, vitest_1.expect)(success).toBe(true);
        (0, vitest_1.expect)(data.present).toBe(false);
        (0, vitest_1.expect)(data.config).toBeNull();
    });
    (0, vitest_1.it)('meldet present:false auch ohne modules-Block', async () => {
        box('garnichts', 'server_name: "x"\n');
        const { success, data } = await status('garnichts');
        (0, vitest_1.expect)(success).toBe(true);
        (0, vitest_1.expect)(data.present).toBe(false);
    });
    (0, vitest_1.it)('unterscheidet "nicht lesbar" klar von "nicht vorhanden"', async () => {
        const { success, data } = await status('gibtesnicht');
        (0, vitest_1.expect)(success).toBe(false);
        (0, vitest_1.expect)(data.error).toContain('nicht gefunden');
        // Entscheidend: KEIN present-Feld, das mit false verwechselt werden koennte.
        (0, vitest_1.expect)(data.present).toBeUndefined();
    });
    (0, vitest_1.it)('faellt bei kaputtem YAML nicht auf present:false zurueck', async () => {
        box('kaputt', 'modules:\n  - module: [unbalanced\n');
        const { success, data } = await status('kaputt');
        (0, vitest_1.expect)(success).toBe(false);
        (0, vitest_1.expect)(data.present).toBeUndefined();
    });
});
