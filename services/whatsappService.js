// services/whatsappService.js
const axios = require('axios');
const logger = require('../utils/logger');

const WHATSAPP_API_URL = 'https://graph.facebook.com/v18.0';
const PHONE_NUMBER_ID = process.env.WA_PHONE_NUMBER_ID;
const ACCESS_TOKEN = process.env.WHATSAPP_TOKEN;

/**
 * Send text message with enhanced formatting
 */
async function sendTextMessage(to, message, options = {}) {
  try {
    const payload = {
      messaging_product: 'whatsapp',
      recipient_type: 'individual',
      to: to,
      type: 'text',
      text: {
        body: message,
        preview_url: options.preview_url || false
      }
    };

    const response = await makeWhatsAppRequest('messages', payload);
    
    logger.info('Text message sent successfully', { 
      to, 
      messageLength: message.length,
      messageId: response.data.messages?.[0]?.id 
    });
    
    return response.data;
  } catch (error) {
    logger.error(`Error sending text message: ${error.message}`, { to });
    throw error;
  }
}

/**
 * Send image with caption
 */
async function sendImageMessage(to, imageUrl, caption = '') {
  try {
    const payload = {
      messaging_product: 'whatsapp',
      recipient_type: 'individual',
      to: to,
      type: 'image',
      image: {
        link: imageUrl,
        caption: caption
      }
    };

    const response = await makeWhatsAppRequest('messages', payload);
    
    logger.info('Image message sent successfully', { 
      to, 
      imageUrl: imageUrl.substring(0, 50) + '...',
      messageId: response.data.messages?.[0]?.id 
    });
    
    return response.data;
  } catch (error) {
    logger.error(`Error sending image message: ${error.message}`, { to });
    throw error;
  }
}

/**
 * Send quick reply buttons
 */
async function sendQuickReply(to, message, buttons, options = {}) {
  try {
    if (!Array.isArray(buttons) || buttons.length === 0) {
      throw new Error('Buttons array is required and cannot be empty');
    }

    if (buttons.length > 3) {
      throw new Error('Maximum 3 buttons allowed for quick reply');
    }

    const payload = {
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
          buttons: buttons.map((button, index) => ({
            type: 'reply',
            reply: {
              id: button.reply?.id || `button_${index}`,
              title: button.reply?.title?.substring(0, 20) || `Option ${index + 1}`
            }
          }))
        }
      }
    };

    // Add header if provided
    if (options.header) {
      payload.interactive.header = {
        type: 'text',
        text: options.header
      };
    }

    // Add footer if provided
    if (options.footer) {
      payload.interactive.footer = {
        text: options.footer
      };
    }

    const response = await makeWhatsAppRequest('messages', payload);
    
    logger.info('Quick reply sent successfully', { 
      to, 
      buttonCount: buttons.length,
      messageId: response.data.messages?.[0]?.id 
    });
    
    return response.data;
  } catch (error) {
    logger.error(`Error sending quick reply: ${error.message}`, { to });
    throw error;
  }
}

/**
 * Send location request
 */
async function sendLocationRequest(to, message, options = {}) {
  try {
    // First send the message
    await sendTextMessage(to, message);
    
    // Then send location request button
    const locationButton = {
      messaging_product: 'whatsapp',
      recipient_type: 'individual',
      to: to,
      type: 'interactive',
      interactive: {
        type: 'button',
        body: {
          text: options.buttonText || 'कृपया तुमचे स्थान शेअर करा / Please share your location'
        },
        action: {
          buttons: [
            {
              type: 'reply',
              reply: {
                id: 'share_location',
                title: '📍 Share Location'
              }
            }
          ]
        }
      }
    };

    const response = await makeWhatsAppRequest('messages', locationButton);
    
    logger.info('Location request sent successfully', { 
      to,
      messageId: response.data.messages?.[0]?.id 
    });
    
    return response.data;
  } catch (error) {
    logger.error(`Error sending location request: ${error.message}`, { to });
    throw error;
  }
}

/**
 * Send list message for multiple options
 */
async function sendListMessage(to, message, sections, options = {}) {
  try {
    if (!Array.isArray(sections) || sections.length === 0) {
      throw new Error('Sections array is required');
    }

    const payload = {
      messaging_product: 'whatsapp',
      recipient_type: 'individual',
      to: to,
      type: 'interactive',
      interactive: {
        type: 'list',
        body: {
          text: message
        },
        action: {
          button: options.buttonText || 'Select Option',
          sections: sections.map(section => ({
            title: section.title,
            rows: section.rows.map(row => ({
              id: row.id,
              title: row.title,
              description: row.description || ''
            }))
          }))
        }
      }
    };

    // Add header if provided
    if (options.header) {
      payload.interactive.header = {
        type: 'text',
        text: options.header
      };
    }

    // Add footer if provided
    if (options.footer) {
      payload.interactive.footer = {
        text: options.footer
      };
    }

    const response = await makeWhatsAppRequest('messages', payload);
    
    logger.info('List message sent successfully', { 
      to,
      sectionCount: sections.length,
      messageId: response.data.messages?.[0]?.id 
    });
    
    return response.data;
  } catch (error) {
    logger.error(`Error sending list message: ${error.message}`, { to });
    throw error;
  }
}

/**
 * Mark message as read
 */
async function markMessageAsRead(messageId) {
  try {
    const payload = {
      messaging_product: 'whatsapp',
      status: 'read',
      message_id: messageId
    };

    await makeWhatsAppRequest('messages', payload);
    
    logger.info('Message marked as read', { messageId });
  } catch (error) {
    logger.error(`Error marking message as read: ${error.message}`, { messageId });
    // Don't throw error for read receipts as it's not critical
  }
}

/**
 * Send template message
 */
async function sendTemplateMessage(to, templateName, languageCode = 'en', components = []) {
  try {
    const payload = {
      messaging_product: 'whatsapp',
      recipient_type: 'individual',
      to: to,
      type: 'template',
      template: {
        name: templateName,
        language: {
          code: languageCode
        },
        components: components
      }
    };

    const response = await makeWhatsAppRequest('messages', payload);
    
    logger.info('Template message sent successfully', { 
      to, 
      templateName,
      messageId: response.data.messages?.[0]?.id 
    });
    
    return response.data;
  } catch (error) {
    logger.error(`Error sending template message: ${error.message}`, { to, templateName });
    throw error;
  }
}

/**
 * Send contact information
 */
async function sendContactMessage(to, contacts) {
  try {
    const payload = {
      messaging_product: 'whatsapp',
      recipient_type: 'individual',
      to: to,
      type: 'contacts',
      contacts: contacts
    };

    const response = await makeWhatsAppRequest('messages', payload);
    
    logger.info('Contact message sent successfully', { 
      to,
      contactCount: contacts.length,
      messageId: response.data.messages?.[0]?.id 
    });
    
    return response.data;
  } catch (error) {
    logger.error(`Error sending contact message: ${error.message}`, { to });
    throw error;
  }
}

/**
 * Make WhatsApp API request with retry logic
 */
async function makeWhatsAppRequest(endpoint, payload, retries = 3) {
  const url = `${WHATSAPP_API_URL}/${PHONE_NUMBER_ID}/${endpoint}`;
  
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      const response = await axios.post(url, payload, {
        headers: {
          'Authorization': `Bearer ${ACCESS_TOKEN}`,
          'Content-Type': 'application/json'
        },
        timeout: 10000 // 10 second timeout
      });

      return response;
    } catch (error) {
      logger.error(`WhatsApp API request failed (attempt ${attempt}/${retries})`, {
        endpoint,
        error: error.response?.data || error.message,
        status: error.response?.status
      });

      if (attempt === retries) {
        throw new Error(`WhatsApp API request failed after ${retries} attempts: ${error.message}`);
      }

      // Wait before retry (exponential backoff)
      await new Promise(resolve => setTimeout(resolve, Math.pow(2, attempt) * 1000));
    }
  }
}

/**
 * Get WhatsApp business profile
 */
async function getBusinessProfile() {
  try {
    const response = await axios.get(`${WHATSAPP_API_URL}/${PHONE_NUMBER_ID}`, {
      headers: {
        'Authorization': `Bearer ${ACCESS_TOKEN}`
      }
    });

    return response.data;
  } catch (error) {
    logger.error(`Error getting business profile: ${error.message}`);
    throw error;
  }
}

/**
 * Update WhatsApp business profile
 */
async function updateBusinessProfile(profileData) {
  try {
    const response = await axios.post(`${WHATSAPP_API_URL}/${PHONE_NUMBER_ID}`, profileData, {
      headers: {
        'Authorization': `Bearer ${ACCESS_TOKEN}`,
        'Content-Type': 'application/json'
      }
    });

    logger.info('Business profile updated successfully');
    return response.data;
  } catch (error) {
    logger.error(`Error updating business profile: ${error.message}`);
    throw error;
  }
}

module.exports = {
  sendTextMessage,
  sendImageMessage,
  sendQuickReply,
  sendLocationRequest,
  sendListMessage,
  sendTemplateMessage,
  sendContactMessage,
  markMessageAsRead,
  getBusinessProfile,
  updateBusinessProfile
};