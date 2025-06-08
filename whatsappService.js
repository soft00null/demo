// services/whatsappService.js - HOTFIX for undefined messageId crash
const axios = require('axios');
const logger = require('../utils/logger');

const WHATSAPP_API_URL = 'https://graph.facebook.com/v18.0';

/**
 * FIXED: Enhanced sendText with parameter validation
 */
async function sendText(to, message) {
  try {
    // ✅ FIXED: Add parameter validation
    if (!to || !message) {
      logger.critical('❌ Invalid parameters for sendText', {
        to: to ? 'provided' : 'missing',
        message: message ? 'provided' : 'missing',
        timestamp: new Date().toISOString()
      });
      throw new Error('Missing required parameters: to and message');
    }

    const data = {
      messaging_product: 'whatsapp',
      recipient_type: 'individual',
      to: to,
      type: 'text',
      text: {
        body: message
      }
    };

    const response = await axios.post(
      `${WHATSAPP_API_URL}/${process.env.WA_PHONE_NUMBER_ID}/messages`,
      data,
      {
        headers: {
          'Authorization': `Bearer ${process.env.WHATSAPP_TOKEN}`,
          'Content-Type': 'application/json'
        },
        timeout: 15000
      }
    );

    logger.info(`✅ Text message sent successfully`, {
      to: to.replace(/^91/, 'XXX-XXX-'),
      messageLength: message.length,
      messageId: response.data.messages?.[0]?.id || 'unknown'
    });
    
    return response.data;
  } catch (error) {
    logger.critical(`💥 Error sending text message`, {
      error: error.message,
      to: to?.replace(/^91/, 'XXX-XXX-') || 'unknown',
      messagePreview: message?.substring(0, 50) + '...' || 'empty',
      stack: error.stack
    });
    throw error;
  }
}

/**
 * FIXED: Enhanced sendImage with parameter validation
 */
async function sendImage(to, imageUrl, caption = '') {
  try {
    // ✅ FIXED: Add parameter validation
    if (!to || !imageUrl) {
      logger.critical('❌ Invalid parameters for sendImage', {
        to: to ? 'provided' : 'missing',
        imageUrl: imageUrl ? 'provided' : 'missing',
        timestamp: new Date().toISOString()
      });
      throw new Error('Missing required parameters: to and imageUrl');
    }

    const data = {
      messaging_product: 'whatsapp',
      recipient_type: 'individual',
      to: to,
      type: 'image',
      image: {
        link: imageUrl,
        caption: caption
      }
    };

    const response = await axios.post(
      `${WHATSAPP_API_URL}/${process.env.WA_PHONE_NUMBER_ID}/messages`,
      data,
      {
        headers: {
          'Authorization': `Bearer ${process.env.WHATSAPP_TOKEN}`,
          'Content-Type': 'application/json'
        },
        timeout: 15000
      }
    );

    logger.info(`✅ Image sent successfully`, {
      to: to.replace(/^91/, 'XXX-XXX-'),
      imageUrl: imageUrl.substring(0, 50) + '...',
      hasCaption: !!caption
    });
    
    return response.data;
  } catch (error) {
    logger.critical(`💥 Error sending image`, {
      error: error.message,
      to: to?.replace(/^91/, 'XXX-XXX-') || 'unknown',
      imageUrl: imageUrl?.substring(0, 50) + '...' || 'missing'
    });
    throw error;
  }
}

/**
 * FIXED: Enhanced sendInteractive with parameter validation  
 */
async function sendInteractive(interactiveData) {
  try {
    // ✅ FIXED: Add parameter validation
    if (!interactiveData || !interactiveData.to) {
      logger.critical('❌ Invalid parameters for sendInteractive', {
        hasData: !!interactiveData,
        hasTo: !!(interactiveData?.to),
        timestamp: new Date().toISOString()
      });
      throw new Error('Missing required parameter: interactiveData with to field');
    }

    const response = await axios.post(
      `${WHATSAPP_API_URL}/${process.env.WA_PHONE_NUMBER_ID}/messages`,
      interactiveData,
      {
        headers: {
          'Authorization': `Bearer ${process.env.WHATSAPP_TOKEN}`,
          'Content-Type': 'application/json'
        },
        timeout: 15000
      }
    );

    logger.info(`✅ Interactive message sent successfully`, {
      to: interactiveData.to.replace(/^91/, 'XXX-XXX-'),
      type: interactiveData.interactive?.type || 'unknown'
    });
    
    return response.data;
  } catch (error) {
    logger.critical(`💥 Error sending interactive message`, {
      error: error.message,
      to: interactiveData?.to?.replace(/^91/, 'XXX-XXX-') || 'unknown',
      type: interactiveData?.interactive?.type || 'unknown'
    });
    throw error;
  }
}

/**
 * FIXED: Enhanced sendQuickReply with parameter validation
 */
async function sendQuickReply(to, message, buttons) {
  try {
    // ✅ FIXED: Add parameter validation
    if (!to || !message || !buttons || !Array.isArray(buttons)) {
      logger.critical('❌ Invalid parameters for sendQuickReply', {
        to: to ? 'provided' : 'missing',
        message: message ? 'provided' : 'missing',
        buttons: Array.isArray(buttons) ? `${buttons.length} buttons` : 'invalid',
        timestamp: new Date().toISOString()
      });
      throw new Error('Missing or invalid parameters for sendQuickReply');
    }

    const data = {
      messaging_product: 'whatsapp',
      recipient_type: 'individual',
      to: to,
      type: 'interactive',
      interactive: {
        type: 'button',
        body: {
          text: message
        },
        action: {
          buttons: buttons
        }
      }
    };

    return await sendInteractive(data);
  } catch (error) {
    logger.critical(`💥 Error sending quick reply`, {
      error: error.message,
      to: to?.replace(/^91/, 'XXX-XXX-') || 'unknown'
    });
    throw error;
  }
}

/**
 * 🚨 CRITICAL FIX: Enhanced markMessageAsRead with comprehensive validation
 */
async function markMessageAsRead(messageId) {
  try {
    // ✅ CRITICAL FIX: Add comprehensive parameter validation
    if (!messageId) {
      logger.warning('⚠️ markMessageAsRead called with undefined/null messageId', {
        messageId: messageId,
        type: typeof messageId,
        timestamp: new Date().toISOString(),
        stack: new Error().stack
      });
      return; // ✅ FIXED: Return gracefully instead of crashing
    }

    // ✅ FIXED: Validate messageId is a string and has content
    if (typeof messageId !== 'string' || messageId.trim().length === 0) {
      logger.warning('⚠️ Invalid messageId format', {
        messageId: messageId,
        type: typeof messageId,
        length: messageId?.length || 0,
        timestamp: new Date().toISOString()
      });
      return; // ✅ FIXED: Return gracefully
    }

    const data = {
      messaging_product: 'whatsapp',
      status: 'read',
      message_id: messageId.trim() // ✅ FIXED: Ensure clean messageId
    };

    const response = await axios.post(
      `${WHATSAPP_API_URL}/${process.env.WA_PHONE_NUMBER_ID}/messages`,
      data,
      {
        headers: {
          'Authorization': `Bearer ${process.env.WHATSAPP_TOKEN}`,
          'Content-Type': 'application/json'
        },
        timeout: 10000
      }
    );

    logger.debug(`✅ Message marked as read successfully`, {
      messageId: messageId.substring(0, 20) + '...',
      timestamp: new Date().toISOString()
    });

    return response.data;
  } catch (error) {
    // ✅ FIXED: Enhanced error handling - don't crash on read receipt failures
    logger.warning(`⚠️ Error marking message as read (non-critical)`, {
      error: error.message,
      messageId: messageId?.substring(0, 20) + '...' || 'undefined',
      status: error.response?.status || 'unknown',
      timestamp: new Date().toISOString()
    });
    
    // ✅ FIXED: Don't throw error - read receipts are not critical
    // This prevents the entire webhook from failing if read receipt fails
    return null;
  }
}

/**
 * Enhanced error handling wrapper for all WhatsApp API calls
 */
async function sendWhatsAppMessage(endpoint, data, messageType = 'unknown') {
  try {
    // ✅ FIXED: Add parameter validation
    if (!endpoint || !data) {
      throw new Error(`Missing required parameters for ${messageType}`);
    }

    const response = await axios.post(
      `${WHATSAPP_API_URL}/${process.env.WA_PHONE_NUMBER_ID}/${endpoint}`,
      data,
      {
        headers: {
          'Authorization': `Bearer ${process.env.WHATSAPP_TOKEN}`,
          'Content-Type': 'application/json'
        },
        timeout: 15000
      }
    );

    logger.info(`✅ WhatsApp ${messageType} sent successfully`, {
      endpoint,
      messageId: response.data.messages?.[0]?.id || 'unknown',
      timestamp: new Date().toISOString()
    });

    return response.data;
  } catch (error) {
    logger.critical(`💥 Error sending WhatsApp ${messageType}`, {
      version: '2.0.0',
      environment: process.env.NODE_ENV || 'development',
      error: error.message,
      endpoint: endpoint || 'unknown',
      recipient: data?.to?.replace(/^91/, 'XXX-XXX-') || 'unknown',
      status: error.response?.status || 'unknown',
      statusText: error.response?.statusText || 'unknown',
      stack: error.stack,
      timestamp: new Date().toISOString()
    });
    throw error;
  }
}

/**
 * Health check for WhatsApp service
 */
async function checkWhatsAppHealth() {
  try {
    if (!process.env.WHATSAPP_TOKEN) {
      return {
        status: 'unhealthy',
        error: 'WHATSAPP_TOKEN not configured',
        timestamp: new Date().toISOString()
      };
    }

    if (!process.env.WA_PHONE_NUMBER_ID) {
      return {
        status: 'unhealthy', 
        error: 'WA_PHONE_NUMBER_ID not configured',
        timestamp: new Date().toISOString()
      };
    }

    // Test API connectivity (without sending actual message)
    const testResponse = await axios.get(
      `${WHATSAPP_API_URL}/${process.env.WA_PHONE_NUMBER_ID}`,
      {
        headers: {
          'Authorization': `Bearer ${process.env.WHATSAPP_TOKEN}`
        },
        timeout: 5000
      }
    );

    return {
      status: 'healthy',
      phoneNumberId: process.env.WA_PHONE_NUMBER_ID,
      apiConnectivity: 'operational',
      timestamp: new Date().toISOString()
    };
  } catch (error) {
    return {
      status: 'unhealthy',
      error: error.message,
      timestamp: new Date().toISOString()
    };
  }
}

module.exports = {
  sendText,
  sendImage, 
  sendInteractive,
  sendQuickReply,
  markMessageAsRead,
  sendWhatsAppMessage,
  checkWhatsAppHealth
};