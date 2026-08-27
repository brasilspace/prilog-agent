/**
 * managed-rooms in der Tenant-Box: Der Modulblock in homeserver.yaml und der
 * Mount im Compose muessen an EINER Bedingung haengen. Ein modules:-Eintrag
 * ohne Mount ist ein Synapse-Crash-Loop (rssw-Incident 2026-05-18).
 */
import { describe, it, expect } from 'vitest';

import { __testables } from './tenant-box.js';

const { renderHomeserverYaml, renderDockerCompose } = __testables;

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
  tier: 'pro' as const,
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

describe('Tenant-Box mit managed-rooms', () => {
  it('laesst homeserver.yaml unangetastet, wenn der Block fehlt', () => {
    const yaml = renderHomeserverYaml(base as never);
    expect(yaml).not.toContain('managed_rooms');
    expect(yaml).not.toContain('modules:');
  });

  it('schreibt Modulklasse, deny und exempt in homeserver.yaml', () => {
    const yaml = renderHomeserverYaml({ ...base, managedRooms } as never);
    expect(yaml).toContain('synapse_managed_rooms.ManagedRoomsModule');
    expect(yaml).toContain('create_room');
    expect(yaml).toContain('allow_invited_joins: true');
    // Das Muster muss maskiert und in Anfuehrungszeichen ueberleben — sonst
    // liest Synapse einen anderen regulaeren Ausdruck als gemeint.
    expect(yaml).toContain('"@(admin|noreply|prilog-bot|system):testschule\\\\.prilog\\\\.team"');
  });

  it('mountet das Modul und ergaenzt den PYTHONPATH', () => {
    const compose = renderDockerCompose({ ...base, managedRooms } as never);
    expect(compose).toContain('./modules/synapse-managed-rooms:/modules/synapse-managed-rooms:ro');
    expect(compose).toContain(
      'PYTHONPATH=/modules/prilog-matrix-connector/src:/modules/synapse-managed-rooms',
    );
  });

  it('mountet nichts, wenn das Modul aus ist', () => {
    const compose = renderDockerCompose(base as never);
    expect(compose).not.toContain('synapse-managed-rooms');
    expect(compose).toContain('PYTHONPATH=/modules/prilog-matrix-connector/src');
  });
});
