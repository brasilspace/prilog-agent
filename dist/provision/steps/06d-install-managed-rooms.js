"use strict";
/**
 * provision/steps/06d-install-managed-rooms.ts
 *
 * Installiert `synapse-managed-rooms` idempotent.
 *
 * Ablauf:
 *  1. Artefakt laden und entpacken
 *  2. homeserver.yaml um den Modulblock erweitern
 *  3. Spaeterer Compose-Step mountet das Modul in den Synapse-Container
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.stepInstallManagedRooms = stepInstallManagedRooms;
exports.verifyInstallManagedRooms = verifyInstallManagedRooms;
const managed_rooms_js_1 = require("../managed-rooms.js");
const logger_js_1 = require("../../utils/logger.js");
async function stepInstallManagedRooms(cfg) {
    const result = await (0, managed_rooms_js_1.ensureManagedRoomsInstalled)(cfg);
    logger_js_1.logger.info(`[Step managed-rooms] ${result.message}`);
}
async function verifyInstallManagedRooms(cfg) {
    (0, managed_rooms_js_1.verifyManagedRoomsInstalled)(cfg);
}
