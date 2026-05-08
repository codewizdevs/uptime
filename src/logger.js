'use strict';

const path = require('path');
const fs = require('fs');
const pino = require('pino');
const config = require('./config');

fs.mkdirSync(config.paths.logs, { recursive: true });

const level = config.appDebug ? 'trace' : 'info';

const fileTransport = {
  target: 'pino-roll',
  options: {
    file: path.join(config.paths.logs, 'app.log'),
    frequency: 'daily',
    mkdir: true,
    size: '20m',
    limit: { count: 14 },
  },
  level,
};

const consoleTransport = {
  target: 'pino-pretty',
  options: {
    colorize: true,
    translateTime: 'SYS:HH:MM:ss.l',
    ignore: 'pid,hostname',
    singleLine: false,
  },
  level,
};

const transport = pino.transport({
  targets: process.env.NODE_ENV === 'production' ? [fileTransport] : [consoleTransport, fileTransport],
});

const logger = pino(
  {
    level,
    base: { app: 'uptime' },
    redact: {
      paths: ['req.headers.cookie', 'req.headers.authorization', '*.password', '*.discord_webhook'],
      censor: '[redacted]',
    },
  },
  transport
);

logger.info(
  { appDebug: config.appDebug, level, logFile: path.join(config.paths.logs, 'app.log') },
  'logger initialized'
);

module.exports = logger;
