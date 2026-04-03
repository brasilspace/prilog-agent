"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.logger = void 0;
const LEVELS = { debug: 0, info: 1, warn: 2, error: 3 };
const MIN_LEVEL = process.env.LOG_LEVEL || 'info';
function log(level, msg, data) {
    if (LEVELS[level] < LEVELS[MIN_LEVEL])
        return;
    const ts = new Date().toISOString();
    const prefix = `[${ts}] [${level.toUpperCase()}]`;
    if (data) {
        console[level === 'error' ? 'error' : 'log'](`${prefix} ${msg}`, data);
    }
    else {
        console[level === 'error' ? 'error' : 'log'](`${prefix} ${msg}`);
    }
}
exports.logger = {
    debug: (msg, data) => log('debug', msg, data),
    info: (msg, data) => log('info', msg, data),
    warn: (msg, data) => log('warn', msg, data),
    error: (msg, data) => log('error', msg, data),
};
