/**
 * Winston logger — structured logs for prod, pretty logs for dev
 */
const winston = require('winston');
const path = require('path');
const fs = require('fs');

const logDir = path.join(__dirname, '..', 'logs');
if (!fs.existsSync(logDir)) fs.mkdirSync(logDir, { recursive: true });

const isProd = process.env.NODE_ENV === 'production';
const level = process.env.LOG_LEVEL || 'info';

const formatDev = winston.format.combine(
  winston.format.colorize(),
  winston.format.timestamp({ format: 'HH:mm:ss' }),
  winston.format.printf(({ timestamp, level, message, ...rest }) => {
    const extra = Object.keys(rest).length ? ` ${JSON.stringify(rest)}` : '';
    return `${timestamp} ${level}: ${message}${extra}`;
  })
);

const formatProd = winston.format.combine(
  winston.format.timestamp(),
  winston.format.errors({ stack: true }),
  winston.format.json()
);

const rawLogger = winston.createLogger({
  level,
  format: isProd ? formatProd : formatDev,
  transports: [
    new winston.transports.Console(),
    new winston.transports.File({ filename: path.join(logDir, 'error.log'), level: 'error' }),
    new winston.transports.File({ filename: path.join(logDir, 'combined.log') })
  ],
  exitOnError: false
});

// Winston's log methods take a single message (or message + metadata
// object) — NOT multiple positional args like console.log. Every call
// site in this codebase uses the console.log-style pattern
// `logger.error('label:', err.message)`, and Winston was silently
// dropping everything after the first argument, hiding real error
// details in production logs all along. This wrapper joins args like
// console.log does, without needing to touch every call site.
function formatArgs(args) {
  return args.map(a => {
    if (a instanceof Error) return a.stack || a.message;
    if (a !== null && typeof a === 'object') { try { return JSON.stringify(a); } catch { return String(a); } }
    return String(a);
  }).join(' ');
}

const logger = {
  error: (...args) => rawLogger.error(formatArgs(args)),
  warn:  (...args) => rawLogger.warn(formatArgs(args)),
  info:  (...args) => rawLogger.info(formatArgs(args)),
  debug: (...args) => rawLogger.debug(formatArgs(args))
};

module.exports = logger;
