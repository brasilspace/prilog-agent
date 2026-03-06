const LEVELS = { debug: 0, info: 1, warn: 2, error: 3 };
const MIN_LEVEL = (process.env.LOG_LEVEL as keyof typeof LEVELS) || 'info';

function log(level: keyof typeof LEVELS, msg: string, data?: unknown) {
  if (LEVELS[level] < LEVELS[MIN_LEVEL]) return;
  const ts = new Date().toISOString();
  const prefix = `[${ts}] [${level.toUpperCase()}]`;
  if (data) {
    console[level === 'error' ? 'error' : 'log'](`${prefix} ${msg}`, data);
  } else {
    console[level === 'error' ? 'error' : 'log'](`${prefix} ${msg}`);
  }
}

export const logger = {
  debug: (msg: string, data?: unknown) => log('debug', msg, data),
  info:  (msg: string, data?: unknown) => log('info',  msg, data),
  warn:  (msg: string, data?: unknown) => log('warn',  msg, data),
  error: (msg: string, data?: unknown) => log('error', msg, data),
};
