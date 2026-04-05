/**
 * STYX — Simple Logger
 *
 * Console-based logger with timestamps and levels.
 * Keeps Styx dependency-free from Obol's pino setup.
 */

type LogLevel = 'debug' | 'info' | 'warn' | 'error';

const LEVEL_PREFIX: Record<LogLevel, string> = {
  debug: '[DEBUG]',
  info: '[INFO] ',
  warn: '[WARN] ',
  error: '[ERROR]',
};

function timestamp(): string {
  return new Date().toISOString().slice(11, 19);
}

function log(level: LogLevel, msg: string): void {
  const quiet = process.env.STYX_LOG_LEVEL === 'quiet';
  if (quiet && level === 'debug') return;
  console.log(`  ${timestamp()} ${LEVEL_PREFIX[level]} ${msg}`);
}

export const logger = {
  debug: (msg: string) => log('debug', msg),
  info: (msg: string) => log('info', msg),
  warn: (msg: string) => log('warn', msg),
  error: (msg: string) => log('error', msg),
};
