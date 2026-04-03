"use strict";
/**
 * provision/steps/06b-install-matrix-connector.ts
 *
 * Installiert und konfiguriert den Prilog Matrix Connector idempotent.
 *
 * Ablauf:
 *  1. Repo clone/pull
 *  2. homeserver.yaml um Modulblock erweitern
 *  3. Spaeterer Compose-Step mountet den Connector in den Synapse-Container
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.stepInstallMatrixConnector = stepInstallMatrixConnector;
exports.verifyInstallMatrixConnector = verifyInstallMatrixConnector;
const connector_js_1 = require("../connector.js");
const logger_js_1 = require("../../utils/logger.js");
async function stepInstallMatrixConnector(cfg) {
    const result = await (0, connector_js_1.ensureMatrixConnectorInstalled)(cfg);
    logger_js_1.logger.info(`[Step connector] ${result.message}`);
}
async function verifyInstallMatrixConnector(cfg) {
    (0, connector_js_1.verifyMatrixConnectorInstalled)(cfg);
}
