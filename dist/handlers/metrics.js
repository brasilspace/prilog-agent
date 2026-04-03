"use strict";
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
exports.collectMetrics = collectMetrics;
const os = __importStar(require("os"));
const child_process_1 = require("child_process");
const config_js_1 = require("../config.js");
const logger_js_1 = require("../utils/logger.js");
// ─── CPU ──────────────────────────────────────────────────────────────────────
function getCpuUsage() {
    return new Promise((resolve) => {
        const start = os.cpus().map(c => c.times);
        setTimeout(() => {
            const end = os.cpus().map(c => c.times);
            let idle = 0, total = 0;
            end.forEach((e, i) => {
                const s = start[i];
                const idleDiff = e.idle - s.idle;
                const totalDiff = Object.values(e).reduce((a, b) => a + b, 0)
                    - Object.values(s).reduce((a, b) => a + b, 0);
                idle += idleDiff;
                total += totalDiff;
            });
            resolve(Math.round((1 - idle / total) * 100));
        }, 500);
    });
}
// ─── RAM ──────────────────────────────────────────────────────────────────────
function getRamMetrics() {
    const total = os.totalmem();
    const free = os.freemem();
    const used = total - free;
    return {
        ramTotal: Math.round(total / 1024 / 1024),
        ramUsed: Math.round(used / 1024 / 1024),
        ramPct: Math.round((used / total) * 100),
    };
}
// ─── Disk ─────────────────────────────────────────────────────────────────────
function getDiskMetrics() {
    const paths = ['/mnt/prilog-data', '/'];
    for (const p of paths) {
        try {
            const out = (0, child_process_1.execSync)(`df -k ${p} --output=size,used,pcent | tail -1`).toString().trim();
            const [sizeKb, usedKb, pctStr] = out.split(/\s+/);
            return {
                diskTotal: Math.round(parseInt(sizeKb) / 1024 / 1024),
                diskUsed: Math.round(parseInt(usedKb) / 1024 / 1024),
                diskPct: parseInt(pctStr),
            };
        }
        catch {
            continue;
        }
    }
    return { diskTotal: 0, diskUsed: 0, diskPct: 0 };
}
// ─── Synapse User Count ───────────────────────────────────────────────────────
async function getSynapseMetrics() {
    try {
        const res = await fetch(`${config_js_1.config.synapseAdminUrl}/_synapse/admin/v2/users?limit=1`, {
            signal: AbortSignal.timeout(3000),
        });
        if (!res.ok)
            return { userCount: 0, up: false };
        const data = await res.json();
        return { userCount: data.total ?? 0, up: true };
    }
    catch {
        return { userCount: 0, up: false };
    }
}
// ─── Volume Usage ─────────────────────────────────────────────────────────────
function getVolumeUsage() {
    const paths = ['/mnt/prilog-data', '/'];
    for (const p of paths) {
        try {
            const out = (0, child_process_1.execSync)(`df -k ${p} --output=pcent | tail -1`).toString().trim();
            return parseInt(out);
        }
        catch {
            continue;
        }
    }
    return 0;
}
// ─── Public ───────────────────────────────────────────────────────────────────
async function collectMetrics() {
    const [cpu, synapse] = await Promise.all([getCpuUsage(), getSynapseMetrics()]);
    const ram = getRamMetrics();
    const disk = getDiskMetrics();
    const vol = getVolumeUsage();
    logger_js_1.logger.debug('Metrics collected', { cpu, ram: ram.ramPct, disk: disk.diskPct, users: synapse.userCount });
    return {
        cpu,
        ram: ram.ramPct,
        ramTotal: ram.ramTotal,
        ramUsed: ram.ramUsed,
        disk: disk.diskPct,
        diskTotal: disk.diskTotal,
        diskUsed: disk.diskUsed,
        volumeUsage: vol,
        matrixUsers: synapse.userCount,
        synapseUp: synapse.up,
        loadAvg: os.loadavg(),
        uptimeSeconds: os.uptime(),
    };
}
