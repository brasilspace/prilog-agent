"use strict";
/**
 * provision/types.ts
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.STEP_NAMES = void 0;
exports.STEP_NAMES = [
    'install_docker',
    'configure_firewall',
    'setup_tailscale',
    'mount_volume',
    'install_nginx',
    'generate_synapse',
    'install_matrix_connector',
    'deploy_web_client',
    'write_compose',
    'start_containers',
    'get_ssl',
    'configure_nginx_ssl',
    'create_admin_user',
    'finalize',
];
