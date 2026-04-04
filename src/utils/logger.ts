import pino from 'pino';
import { config } from '../config/env.js';

export const logger = pino({
  level: config.logging.level,
  transport: config.server.isDevelopment
    ? {
        target: 'pino-pretty',
        options: {
          translateTime: 'HH:MM:ss',
          ignore: 'pid,hostname',
        },
      }
    : undefined,
});
