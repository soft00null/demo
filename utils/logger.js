// utils/logger.js
const winston = require('winston');
const path = require('path');
const fs = require('fs');

// Ensure logs directory exists
const logsDir = path.join(process.cwd(), 'logs');
if (!fs.existsSync(logsDir)) {
  fs.mkdirSync(logsDir, { recursive: true });
}

// Check if we're in development mode
const isDevelopment = process.env.NODE_ENV !== 'production';

// Custom format for console output (colorized and readable)
const consoleFormat = winston.format.combine(
  winston.format.timestamp({
    format: 'HH:mm:ss'
  }),
  winston.format.colorize({ all: true }),
  winston.format.errors({ stack: true }),
  winston.format.printf(({ level, message, timestamp, service, ...meta }) => {
    let log = `🕐 ${timestamp} [${level}]`;
    
    if (service) {
      log += ` [${service.toUpperCase()}]`;
    }
    
    log += `: ${message}`;
    
    // Add metadata if present
    if (Object.keys(meta).length > 0) {
      const metaStr = JSON.stringify(meta, null, 0);
      if (metaStr !== '{}') {
        log += ` | ${metaStr}`;
      }
    }
    
    return log;
  })
);

// Custom format for file output (structured JSON)
const fileFormat = winston.format.combine(
  winston.format.timestamp(),
  winston.format.errors({ stack: true }),
  winston.format.json()
);

// Create logger with multiple transports
const logger = winston.createLogger({
  level: isDevelopment ? 'debug' : 'info',
  defaultMeta: { 
    service: 'pcmc-whatsapp-bot',
    version: '2.0.0',
    environment: process.env.NODE_ENV || 'development',
    timestamp: new Date().toISOString()
  },
  transports: [
    // Error logs - separate file for errors only
    new winston.transports.File({
      filename: path.join(logsDir, 'error.log'),
      level: 'error',
      maxsize: 5242880, // 5MB
      maxFiles: 5,
      format: fileFormat
    }),
    
    // Combined logs - all levels
    new winston.transports.File({
      filename: path.join(logsDir, 'combined.log'),
      maxsize: 5242880, // 5MB
      maxFiles: 10,
      format: fileFormat
    })
  ],
  
  // Handle uncaught exceptions
  exceptionHandlers: [
    new winston.transports.File({
      filename: path.join(logsDir, 'exceptions.log')
    })
  ],
  
  // Handle unhandled promise rejections
  rejectionHandlers: [
    new winston.transports.File({
      filename: path.join(logsDir, 'rejections.log')
    })
  ]
});

// Add console transport for development OR if explicitly enabled
if (isDevelopment || process.env.ENABLE_CONSOLE_LOGS === 'true') {
  logger.add(new winston.transports.Console({
    format: consoleFormat,
    level: isDevelopment ? 'debug' : 'info'
  }));
  
  // Also add console transport for exceptions in development
  logger.exceptions.handle(
    new winston.transports.Console({
      format: consoleFormat
    })
  );
}

// Add startup message
if (isDevelopment) {
  logger.info('🚀 Logger initialized for development', {
    logLevel: logger.level,
    consoleLogging: true,
    logsDirectory: logsDir
  });
}

// Enhanced logging methods with service tags and emojis
logger.startup = (message, data = {}) => {
  logger.info(`🚀 STARTUP: ${message}`, { service: 'startup', ...data });
};

logger.webhook = (message, data = {}) => {
  logger.info(`📡 WEBHOOK: ${message}`, { service: 'webhook', ...data });
};

logger.ai = (message, data = {}) => {
  logger.info(`🤖 AI: ${message}`, { service: 'ai', ...data });
};

logger.firebase = (message, data = {}) => {
  logger.info(`🔥 FIREBASE: ${message}`, { service: 'firebase', ...data });
};

logger.whatsapp = (message, data = {}) => {
  logger.info(`💬 WHATSAPP: ${message}`, { service: 'whatsapp', ...data });
};

logger.complaint = (message, data = {}) => {
  logger.info(`📝 COMPLAINT: ${message}`, { service: 'complaint', ...data });
};

logger.citizen = (message, data = {}) => {
  logger.info(`👤 CITIZEN: ${message}`, { service: 'citizen', ...data });
};

logger.debug = (message, data = {}) => {
  logger.log('debug', `🔍 DEBUG: ${message}`, { service: 'debug', ...data });
};

logger.success = (message, data = {}) => {
  logger.info(`✅ SUCCESS: ${message}`, { service: 'success', ...data });
};

logger.warning = (message, data = {}) => {
  logger.warn(`⚠️  WARNING: ${message}`, { service: 'warning', ...data });
};

logger.critical = (message, data = {}) => {
  logger.error(`🚨 CRITICAL: ${message}`, { service: 'critical', ...data });
};

module.exports = logger;