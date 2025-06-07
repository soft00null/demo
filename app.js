// app.js - Updated with proper error handling
require('dotenv').config();
const express = require('express');
const bodyParser = require('body-parser');
const rateLimit = require('express-rate-limit');

// Import services
const logger = require('./utils/logger');
const { initializeFirebase } = require('./services/firebaseService');

// Import routes
const webhookRouter = require('./routes/webhook');

const app = express();

// Trust proxy (for services like Glitch, Heroku, etc.)
app.set('trust proxy', 1);

// Body parser middleware
app.use(bodyParser.json({
  limit: '10mb',
  verify: (req, res, buf) => {
    // Store raw body for webhook verification if needed
    req.rawBody = buf;
  }
}));

app.use(bodyParser.urlencoded({ extended: true, limit: '10mb' }));

// Rate limiting
const limiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 1000, // Increased limit for production
  message: {
    error: 'Too many requests',
    message: 'Rate limit exceeded. Please try again later.',
    retryAfter: '15 minutes'
  },
  standardHeaders: true,
  legacyHeaders: false
});

app.use(limiter);

// Health check endpoint
app.get('/health', (req, res) => {
  res.status(200).json({
    status: 'healthy',
    service: 'PCMC WhatsApp Bot',
    version: '2.0.0',
    timestamp: new Date().toISOString(),
    uptime: process.uptime(),
    memory: process.memoryUsage(),
    environment: process.env.NODE_ENV || 'development'
  });
});

// Root endpoint
app.get('/', (req, res) => {
  res.status(200).json({
    message: 'PCMC WhatsApp Bot API',
    version: '2.0.0',
    status: 'operational',
    endpoints: {
      webhook: '/webhook',
      health: '/health'
    },
    timestamp: new Date().toISOString()
  });
});

// Webhook routes
app.use('/webhook', webhookRouter);

// 404 handler
app.use((req, res) => {
  logger.warning('❓ 404 - Route not found', {
    method: req.method,
    path: req.path,
    ip: req.ip,
    userAgent: req.get('User-Agent')
  });

  res.status(404).json({
    error: 'Not Found',
    message: `Route ${req.method} ${req.path} not found`,
    availableRoutes: [
      'GET /',
      'GET /health',
      'GET /webhook',
      'POST /webhook'
    ],
    timestamp: new Date().toISOString()
  });
});

// Global error handler
app.use((err, req, res, next) => {
  logger.critical('💥 Global error handler', {
    error: err.message,
    stack: err.stack,
    method: req.method,
    path: req.path,
    ip: req.ip
  });

  res.status(500).json({
    error: 'Internal Server Error',
    message: 'An unexpected error occurred',
    timestamp: new Date().toISOString()
  });
});

// Initialize services
async function initializeServices() {
  try {
    logger.firebase('🔥 Initializing Firebase...');
    initializeFirebase();
    logger.success('✅ Firebase initialized successfully');

    // Check environment variables
    const requiredEnvVars = [
      'VERIFY_TOKEN',
      'WHATSAPP_TOKEN', 
      'WA_PHONE_NUMBER_ID',
      'OPENAI_API_KEY',
      'FIREBASE_SERVICE_ACCOUNT_PATH'
    ];

    const missingVars = requiredEnvVars.filter(varName => !process.env[varName]);
    
    if (missingVars.length > 0) {
      logger.critical('❌ Missing required environment variables', {
        missing: missingVars,
        provided: requiredEnvVars.filter(varName => !!process.env[varName])
      });
    } else {
      logger.success('✅ All required environment variables are configured');
    }

  } catch (error) {
    logger.critical('💥 Service initialization failed', {
      error: error.message,
      stack: error.stack
    });
    process.exit(1);
  }
}

// Start server
const PORT = process.env.PORT || 3000;

async function startServer() {
  try {
    await initializeServices();
    
    app.listen(PORT, () => {
      logger.success(`🚀 PCMC WhatsApp Bot is running on port ${PORT}`, {
        port: PORT,
        environment: process.env.NODE_ENV || 'development',
        version: '2.0.0',
        nodeVersion: process.version,
        timestamp: new Date().toISOString()
      });
    });
  } catch (error) {
    logger.critical('💥 Failed to start server', {
      error: error.message,
      stack: error.stack,
      port: PORT
    });
    process.exit(1);
  }
}

// Handle process events
process.on('uncaughtException', (error) => {
  logger.critical('💥 Uncaught Exception', {
    error: error.message,
    stack: error.stack
  });
  process.exit(1);
});

process.on('unhandledRejection', (reason, promise) => {
  logger.critical('💥 Unhandled Rejection', {
    reason: reason,
    promise: promise
  });
  process.exit(1);
});

process.on('SIGTERM', () => {
  logger.info('🛑 SIGTERM received. Shutting down gracefully...');
  process.exit(0);
});

process.on('SIGINT', () => {
  logger.info('🛑 SIGINT received. Shutting down gracefully...');
  process.exit(0);
});

// Start the server
startServer();