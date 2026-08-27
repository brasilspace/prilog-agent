/**
 * Zwei Module in einem Container: die Stelle, an der ein zweiter
 * PYTHONPATH-Eintrag den ersten still ueberschreiben wuerde.
 */
import { describe, it, expect } from 'vitest';

import { buildComposeContent } from './compose.js';
import { ProvisionConfig } from './types.js';

function baseConfig(overrides: Partial<ProvisionConfig> = {}): ProvisionConfig {
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
  } as ProvisionConfig;
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

describe('buildComposeContent', () => {
  it('setzt keinen PYTHONPATH, wenn kein Modul aktiv ist', () => {
    const yaml = buildComposeContent(baseConfig());
    expect(yaml).not.toContain('PYTHONPATH');
  });

  it('setzt einen PYTHONPATH fuer den Connector allein', () => {
    const yaml = buildComposeContent(
      baseConfig({ synapseModules: { installPlan: [], enabledModules: [], connector } } as never),
    );
    expect(yaml).toContain('PYTHONPATH: /modules/prilog-matrix-connector/src');
    expect(yaml).not.toContain('/modules/synapse-managed-rooms');
  });

  it('haengt beide Module an EINEN PYTHONPATH, durch Doppelpunkt getrennt', () => {
    const yaml = buildComposeContent(
      baseConfig({
        synapseModules: { installPlan: [], enabledModules: [], connector, managedRooms },
      } as never),
    );
    expect(yaml).toContain(
      'PYTHONPATH: /modules/prilog-matrix-connector/src:/modules/synapse-managed-rooms',
    );
    // Genau eine PYTHONPATH-Zeile — zwei wuerden sich gegenseitig ausloeschen.
    expect(yaml.match(/PYTHONPATH:/g)).toHaveLength(1);
  });

  it('mountet managed-rooms schreibgeschuetzt', () => {
    const yaml = buildComposeContent(
      baseConfig({
        synapseModules: { installPlan: [], enabledModules: [], connector, managedRooms },
      } as never),
    );
    expect(yaml).toContain(
      '- /opt/prilog/modules/synapse-managed-rooms:/modules/synapse-managed-rooms:ro',
    );
  });

  it('kommt auch ohne Connector aus', () => {
    const yaml = buildComposeContent(
      baseConfig({
        synapseModules: { installPlan: [], enabledModules: [], connector: null, managedRooms },
      } as never),
    );
    expect(yaml).toContain('PYTHONPATH: /modules/synapse-managed-rooms');
  });
});
