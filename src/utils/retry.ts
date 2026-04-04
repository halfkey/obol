import { logger } from './logger.js';

export interface RetryOptions {
  maxRetries?: number;
  initialDelayMs?: number;
  maxDelayMs?: number;
  backoffMultiplier?: number;
}

const DEFAULTS: Required<RetryOptions> = {
  maxRetries: 3,
  initialDelayMs: 1000,
  maxDelayMs: 10000,
  backoffMultiplier: 2,
};

/** Retry an async operation with exponential backoff */
export async function withRetry<T>(
  operation: () => Promise<T>,
  options: RetryOptions = {},
  context?: string,
): Promise<T> {
  const opts = { ...DEFAULTS, ...options };
  let delay = opts.initialDelayMs;

  for (let attempt = 0; attempt <= opts.maxRetries; attempt++) {
    try {
      return await operation();
    } catch (error) {
      const isLast = attempt === opts.maxRetries;
      const msg = error instanceof Error ? error.message : String(error);

      if (isLast || !isRetryable(error)) {
        logger.error({ context, attempt: attempt + 1, error: msg }, 'Operation failed');
        throw error;
      }

      logger.warn({ context, attempt: attempt + 1, nextRetryMs: delay, error: msg }, 'Retrying');
      await sleep(delay);
      delay = Math.min(delay * opts.backoffMultiplier, opts.maxDelayMs);
    }
  }

  throw new Error('Unreachable');
}

function isRetryable(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  const msg = error.message.toLowerCase();
  return (
    msg.includes('timeout') ||
    msg.includes('enotfound') ||
    msg.includes('econnrefused') ||
    msg.includes('fetch failed') ||
    msg.includes('429') ||
    msg.includes('rate limit') ||
    /5\d{2}/.test(msg)
  );
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}
