import pino from 'pino';
import env from '../config/environment.js';

export const logger = pino({
  level: env.logLevel,
  transport: env.isDev
    ? { target: 'pino-pretty', options: { colorize: true, translateTime: 'HH:MM:ss' } }
    : undefined,
});

export default logger;
