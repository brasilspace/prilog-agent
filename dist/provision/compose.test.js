"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
/**
 * Zwei Module in einem Container: die Stelle, an der ein zweiter
 * PYTHONPATH-Eintrag den ersten still ueberschreiben wuerde.
 */
const vitest_1 = require("vitest");
const compose_js_1 = require("./compose.js");
function baseConfig(overrides = {}) {
    return {
        orderId: 'ord_1',
        subdomain: 'testschule',
        matrixDomain: 'testschule.prilog.chat',
        webappDomain: 'app.testschule.prilog.chat',
        tailscaleAuthKey: 'tskey-x',
        hetznerVolumeId: 'vol-1',
        dbHost: 'prilog-postgres-1',
        dbPassword: 'pw',
        registrationSecret: 'reg',
        macaroonSecret: 'mac',
        formSecret: 'form',
        adminUsername: 'admin',
        adminPasswordB64: 'cHc=',
        maxUploadSize: 50,
        backendApiUrl: 'https://api.prilog.chat',
        agentToken: 'tok',
        ...overrides,
    };
}
const connector = {
    enabled: true,
    moduleName: 'prilog_matrix_connector',
    moduleClass: 'prilog_matrix_connector.module.PrilogMatrixConnectorModule',
    packageRepo: 'git@github.com:brasilspace/prilog-matrix-connector.git',
    config: {
        prilogApiUrl: 'https://api.prilog.chat',
        sharedSecret: 's',
        allowServerAdminBypass: true,
        requestTimeoutSeconds: 5,
    },
};
const managedRooms = {
    enabled: true,
    moduleName: 'synapse_managed_rooms',
    moduleClass: 'synapse_managed_rooms.ManagedRoomsModule',
    packageUrl: 'https://artifacts.example/managed-rooms.tar.gz',
    config: {
        deny: ['create_room', 'invite'],
        exempt: [{ match: '@admin:testschule\\.prilog\\.chat', allow: ['create_room', 'invite'] }],
        allow_direct_messages: true,
        allow_invited_joins: true,
    },
};
(0, vitest_1.describe)('buildComposeContent', () => {
    (0, vitest_1.it)('setzt keinen PYTHONPATH, wenn kein Modul aktiv ist', () => {
        const yaml = (0, compose_js_1.buildComposeContent)(baseConfig());
        (0, vitest_1.expect)(yaml).not.toContain('PYTHONPATH');
    });
    (0, vitest_1.it)('setzt einen PYTHONPATH fuer den Connector allein', () => {
        const yaml = (0, compose_js_1.buildComposeContent)(baseConfig({ synapseModules: { installPlan: [], enabledModules: [], connector } }));
        (0, vitest_1.expect)(yaml).toContain('PYTHONPATH: /modules/prilog-matrix-connector/src');
        (0, vitest_1.expect)(yaml).not.toContain('/modules/synapse-managed-rooms');
    });
    (0, vitest_1.it)('haengt beide Module an EINEN PYTHONPATH, durch Doppelpunkt getrennt', () => {
        const yaml = (0, compose_js_1.buildComposeContent)(baseConfig({
            synapseModules: { installPlan: [], enabledModules: [], connector, managedRooms },
        }));
        (0, vitest_1.expect)(yaml).toContain('PYTHONPATH: /modules/prilog-matrix-connector/src:/modules/synapse-managed-rooms');
        // Genau eine PYTHONPATH-Zeile — zwei wuerden sich gegenseitig ausloeschen.
        (0, vitest_1.expect)(yaml.match(/PYTHONPATH:/g)).toHaveLength(1);
    });
    (0, vitest_1.it)('mountet managed-rooms schreibgeschuetzt', () => {
        const yaml = (0, compose_js_1.buildComposeContent)(baseConfig({
            synapseModules: { installPlan: [], enabledModules: [], connector, managedRooms },
        }));
        (0, vitest_1.expect)(yaml).toContain('- /opt/prilog/modules/synapse-managed-rooms:/modules/synapse-managed-rooms:ro');
    });
    (0, vitest_1.it)('kommt auch ohne Connector aus', () => {
        const yaml = (0, compose_js_1.buildComposeContent)(baseConfig({
            synapseModules: { installPlan: [], enabledModules: [], connector: null, managedRooms },
        }));
        (0, vitest_1.expect)(yaml).toContain('PYTHONPATH: /modules/synapse-managed-rooms');
    });
});
