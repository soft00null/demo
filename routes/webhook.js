// routes/webhook.js - Fixed webhook routes
const express = require('express');
const router = express.Router();
const { handleWebhook } = require('../controllers/webhookController');
const logger = require('../utils/logger');

/**
 * POST /webhook - Main webhook endpoint for WhatsApp messages
 */
router.post('/', handleWebhook);

/**
 * GET /webhook - Webhook verification endpoint for WhatsApp setup
 */
router.get('/', (req, res) => {
  try {
    const mode = req.query['hub.mode'];
    const token = req.query['hub.verify_token'];
    const challenge = req.query['hub.challenge'];

    logger.webhook('🔐 Webhook verification request received', {
      mode,
      tokenProvided: !!token,
      challengeProvided: !!challenge,
      expectedToken: process.env.VERIFY_TOKEN ? 'configured' : 'missing',
      ip: req.ip,
      userAgent: req.get('User-Agent'),
      timestamp: new Date().toISOString()
    });

    // Verify the webhook
    if (mode && token) {
      if (mode === 'subscribe' && token === process.env.VERIFY_TOKEN) {
        logger.success('✅ Webhook verification successful', {
          challenge,
          verifyToken: 'matched'
        });
        return res.status(200).send(challenge);
      } else {
        logger.warning('❌ Webhook verification failed', {
          mode,
          tokenMatch: token === process.env.VERIFY_TOKEN,
          providedToken: token ? 'provided' : 'missing',
          expectedToken: process.env.VERIFY_TOKEN ? 'configured' : 'missing'
        });
        return res.status(403).json({
          error: 'Forbidden',
          message: 'Webhook verification failed',
          timestamp: new Date().toISOString()
        });
      }
    }

    logger.warning('❌ Invalid webhook verification request', {
      mode,
      token: !!token,
      missingParams: {
        mode: !mode,
        token: !token
      }
    });

    return res.status(400).json({
      error: 'Bad Request',
      message: 'Missing required parameters for webhook verification',
      required: ['hub.mode', 'hub.verify_token', 'hub.challenge'],
      timestamp: new Date().toISOString()
    });

  } catch (error) {
    logger.critical('💥 Error in webhook verification', {
      error: error.message,
      stack: error.stack,
      query: req.query,
      ip: req.ip
    });

    return res.status(500).json({
      error: 'Internal Server Error',
      message: 'Webhook verification failed due to server error',
      timestamp: new Date().toISOString()
    });
  }
});

/**
 * Health check endpoint for webhook
 */
router.get('/health', (req, res) => {
  try {
    const healthData = {
      status: 'healthy',
      service: 'PCMC WhatsApp Webhook',
      version: '2.0.0',
      timestamp: new Date().toISOString(),
      uptime: process.uptime(),
      memory: process.memoryUsage(),
      environment: process.env.NODE_ENV || 'development',
      endpoints: {
        webhook_post: '/webhook (POST)',
        webhook_verify: '/webhook (GET)',
        health: '/webhook/health (GET)'
      }
    };

    logger.webhook('🏥 Health check requested', {
      ip: req.ip,
      userAgent: req.get('User-Agent'),
      uptime: Math.round(process.uptime()),
      memoryUsage: Math.round(process.memoryUsage().heapUsed / 1024 / 1024) + 'MB'
    });

    res.status(200).json(healthData);

  } catch (error) {
    logger.critical('💥 Error in health check', {
      error: error.message,
      stack: error.stack
    });

    res.status(500).json({
      status: 'unhealthy',
      error: error.message,
      timestamp: new Date().toISOString()
    });
  }
});

/**
 * Status endpoint for webhook monitoring
 */
router.get('/status', (req, res) => {
  try {
    const statusData = {
      webhook: {
        status: 'operational',
        lastActivity: new Date().toISOString(),
        version: '2.0.0'
      },
      environment: {
        node_version: process.version,
        platform: process.platform,
        arch: process.arch,
        memory: {
          used: Math.round(process.memoryUsage().heapUsed / 1024 / 1024) + 'MB',
          total: Math.round(process.memoryUsage().heapTotal / 1024 / 1024) + 'MB'
        }
      },
      configuration: {
        verify_token: !!process.env.VERIFY_TOKEN,
        whatsapp_token: !!process.env.WHATSAPP_TOKEN,
        openai_key: !!process.env.OPENAI_API_KEY,
        firebase_config: !!process.env.FIREBASE_SERVICE_ACCOUNT_PATH,
        google_maps_key: !!process.env.GOOGLE_MAPS_API_KEY,
        port: process.env.PORT || 3000
      }
    };

    logger.webhook('📊 Status check requested', {
      ip: req.ip,
      configurationKeys: Object.keys(statusData.configuration).filter(
        key => statusData.configuration[key] === true
      )
    });

    res.status(200).json(statusData);

  } catch (error) {
    logger.critical('💥 Error in status check', {
      error: error.message,
      stack: error.stack
    });

    res.status(500).json({
      error: 'Status check failed',
      message: error.message,
      timestamp: new Date().toISOString()
    });
  }
});

/**
 * Catch-all route for unsupported methods on webhook
 */
router.all('*', (req, res) => {
  logger.warning('❓ Unsupported webhook request', {
    method: req.method,
    path: req.path,
    query: req.query,
    ip: req.ip,
    userAgent: req.get('User-Agent')
  });

  res.status(405).json({
    error: 'Method Not Allowed',
    message: `${req.method} method not supported on ${req.path}`,
    supported_methods: ['GET', 'POST'],
    supported_endpoints: [
      'GET /webhook - Webhook verification',
      'POST /webhook - Webhook messages',
      'GET /webhook/health - Health check',
      'GET /webhook/status - Status check'
    ],
    timestamp: new Date().toISOString()
  });
});

module.exports = router;