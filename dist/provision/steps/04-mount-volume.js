"use strict";
/**
 * provision/steps/04-mount-volume.ts
 *
 * Hetzner Volume mounten via fstab.
 * Device: /dev/disk/by-id/scsi-0HC_Volume_<hetznerVolumeId>
 */
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.stepMountVolume = stepMountVolume;
exports.verifyMountVolume = verifyMountVolume;
const fs = __importStar(require("fs"));
const logger_js_1 = require("../../utils/logger.js");
const safe_exec_js_1 = require("../engine/safe-exec.js");
const MOUNT_POINT = '/mnt/prilog-data';
async function isVolumeMounted() {
    const result = await (0, safe_exec_js_1.safeExec)('mountpoint', ['-q', MOUNT_POINT], { ignoreExitCode: true });
    return result.exitCode === 0;
}
async function stepMountVolume(cfg) {
    // Device-Pfad mit numerischer Hetzner Volume ID
    const device = `/dev/disk/by-id/scsi-0HC_Volume_${cfg.hetznerVolumeId}`;
    if (await isVolumeMounted()) {
        logger_js_1.logger.info('[Step 04] Volume bereits gemountet — überspringe');
    }
    else {
        logger_js_1.logger.info(`[Step 04] Mounte ${device} → ${MOUNT_POINT}`);
        fs.mkdirSync(MOUNT_POINT, { recursive: true });
        // fstab Eintrag (idempotent)
        const fstabLine = `${device} ${MOUNT_POINT} ext4 discard,nofail,defaults 0 0`;
        const fstab = fs.readFileSync('/etc/fstab', 'utf-8');
        if (!fstab.includes(device)) {
            fs.appendFileSync('/etc/fstab', `\n${fstabLine}\n`, 'utf-8');
            logger_js_1.logger.info('[Step 04] fstab Eintrag hinzugefügt');
        }
        await (0, safe_exec_js_1.safeExec)('mount', ['-o', 'discard,defaults', device, MOUNT_POINT], { timeout: 30_000 });
        logger_js_1.logger.info('[Step 04] Volume gemountet');
    }
    // ── Verzeichnisse anlegen (idempotent) ───────────────────────────
    for (const dir of [
        `${MOUNT_POINT}/postgres`,
        `${MOUNT_POINT}/synapse`,
        `${MOUNT_POINT}/backups`,
        `${MOUNT_POINT}/media`,
        '/opt/prilog',
        '/opt/prilog/scripts',
        '/etc/prilog',
        '/var/www/html',
        '/var/www/element',
    ]) {
        fs.mkdirSync(dir, { recursive: true });
    }
    logger_js_1.logger.info('[Step 04] Verzeichnisse eingerichtet');
}
async function verifyMountVolume(_cfg) {
    if (!(await isVolumeMounted())) {
        throw new Error('Volume nicht gemountet nach Setup');
    }
    for (const dir of [`${MOUNT_POINT}/postgres`, `${MOUNT_POINT}/synapse`]) {
        if (!fs.existsSync(dir)) {
            throw new Error(`Verzeichnis ${dir} fehlt nach Volume-Mount`);
        }
    }
}
