/* eslint-disable no-console */
// Minimal structured logger. Swap for pino/winston later without touching callers.
const ts = () => new Date().toISOString();
const quiet = process.env.NODE_ENV === 'test' && !process.env.DEBUG_LOGS;

export const logger = {
  info: (msg: string, ...meta: unknown[]) => quiet || console.log(`[${ts()}] INFO  ${msg}`, ...meta),
  warn: (msg: string, ...meta: unknown[]) => quiet || console.warn(`[${ts()}] WARN  ${msg}`, ...meta),
  error: (msg: string, ...meta: unknown[]) => console.error(`[${ts()}] ERROR ${msg}`, ...meta),
};
