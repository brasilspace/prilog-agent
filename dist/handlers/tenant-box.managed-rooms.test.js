"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
/**
 * managed-rooms in der Tenant-Box: Der Modulblock in homeserver.yaml und der
 * Mount im Compose muessen an EINER Bedingung haengen. Ein modules:-Eintrag
 * ohne Mount ist ein Synapse-Crash-Loop (rssw-Incident 2026-05-18).
 */
const vitest_1 = require("vitest");
const tenant_box_js_1 = require("./tenant-box.js");
const { renderHomeserverYaml, renderDockerCompose } = tenant_box_js_1.__testables;
const base = {
    slug: 'testschule',
    domain: 'testschule.prilog.team',
    serverName: 'testschule.prilog.team',
    publicBaseUrl: 'https://testschule.prilog.team/',
    synapsePort: 8123,
    minioPort: 9123,
    pgPassword: 'x'.repeat(24),
    minioRootUser: 'tb-testschule',
    minioRootPassword: 'y'.repeat(24),
    minioBucket: 'tenant-testschule',
    registrationSecret: 'z'.repeat(32),
    tier: 'pro',
    adminUsername: 'admin',
    adminPassword: 'pw',
};
const managedRooms = {
    deny: ['create_room', 'invite', '3pid_invite', 'join_room', 'create_room_alias', 'publish_room'],
    exempt: [
        {
            match: '@(admin|noreply|prilog-bot|system):testschule\\.prilog\\.team',
            allow: ['create_room', 'invite', '3pid_invite', 'join_room', 'create_room_alias', 'publish_room'],
        },
    ],
    allow_direct_messages: true,
    allow_invited_joins: true,
};
(0, vitest_1.describe)('Tenant-Box mit managed-rooms', () => {
    (0, vitest_1.it)('laesst homeserver.yaml unangetastet, wenn der Block fehlt', () => {
        const yaml = renderHomeserverYaml(base);
        (0, vitest_1.expect)(yaml).not.toContain('managed_rooms');
        (0, vitest_1.expect)(yaml).not.toContain('modules:');
    });
    (0, vitest_1.it)('schreibt Modulklasse, deny und exempt in homeserver.yaml', () => {
        const yaml = renderHomeserverYaml({ ...base, managedRooms });
        (0, vitest_1.expect)(yaml).toContain('synapse_managed_rooms.ManagedRoomsModule');
        (0, vitest_1.expect)(yaml).toContain('create_room');
        (0, vitest_1.expect)(yaml).toContain('allow_invited_joins: true');
        // Das Muster muss maskiert und in Anfuehrungszeichen ueberleben — sonst
        // liest Synapse einen anderen regulaeren Ausdruck als gemeint.
        (0, vitest_1.expect)(yaml).toContain('"@(admin|noreply|prilog-bot|system):testschule\\\\.prilog\\\\.team"');
    });
    (0, vitest_1.it)('mountet das Modul und ergaenzt den PYTHONPATH', () => {
        const compose = renderDockerCompose({ ...base, managedRooms });
        (0, vitest_1.expect)(compose).toContain('./modules/synapse-managed-rooms:/modules/synapse-managed-rooms:ro');
        (0, vitest_1.expect)(compose).toContain('PYTHONPATH=/modules/prilog-matrix-connector/src:/modules/synapse-managed-rooms');
    });
    (0, vitest_1.it)('mountet nichts, wenn das Modul aus ist', () => {
        const compose = renderDockerCompose(base);
        (0, vitest_1.expect)(compose).not.toContain('synapse-managed-rooms');
        (0, vitest_1.expect)(compose).toContain('PYTHONPATH=/modules/prilog-matrix-connector/src');
    });
});
