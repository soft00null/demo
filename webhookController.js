// controllers/webhookController.js - Complete webhook controller with all features
// Last Updated: 2025-06-07 22:04:46 UTC by soft00null
const admin = require('firebase-admin');
const fs = require('fs');
const path = require('path');
const axios = require('axios');
const logger = require('../utils/logger');
const { generateTicketId, formatPhoneNumber, sanitizeInput, formatTimestamp, containsDevanagari } = require('../utils/helpers');

// Import services with CORRECT function names
const {
  ensureCitizenExists,
  getCitizenBotMode,
  saveChatMessage,
  getConversationContext,
  updateCitizenEthicalScore,
  updateCitizenStats,
  checkDuplicateComplaint,
  createDraftComplaint,
  confirmComplaint,
  cancelComplaint,
  getUserComplaintStatus,
  geocodeAddress,
  getMediaUrl,
  downloadAndUploadImage,
  createTicketRecord,
  addUserToComplaintFollowUp
} = require('../services/firebaseService');

const {
  processMessageWithAI,
  analyzeIntent,
  checkComplaintSimilarity,
  isComplaintStatusQuery,
  calculateEthicalScore,
  categorizeDepartment,
  assessComplaintPriority,
  categorizeComplaintType,
  transcribeAudio,
  analyzeImageContent,
  detectLanguage
} = require('../services/aiService');

// FIXED: Import with correct function names
const {
  sendTextMessage,    // FIXED: Added missing import
  sendImageMessage,
  sendQuickReply,
  sendListMessage,
  sendLocationRequest,
  sendInteractive,
  markMessageAsRead
} = require('../services/whatsappService');

// Configuration constants
const WEBHOOK_VERSION = '2.0.0';
const MAX_PROCESSING_TIME = 30000; // 30 seconds
const RATE_LIMIT_WINDOW = 60000; // 1 minute
const RATE_LIMIT_MAX_MESSAGES = 20;
const WEBHOOK_UPDATED = '2025-06-07 22:04:46 UTC';
const UPDATED_BY = 'soft00null';

// In-memory rate limiting store
const rateLimitStore = new Map();

/*
 * Main webhook handler for WhatsApp Cloud API
 */
async function handleWebhook(req, res) {
  const requestId = generateTicketId(8);
  const startTime = Date.now();
  
  try {
    logger.webhook('🚀 Webhook request received', {
      requestId,
      method: req.method,
      userAgent: req.get('User-Agent'),
      contentType: req.get('Content-Type'),
      bodySize: JSON.stringify(req.body).length,
      timestamp: new Date().toISOString(),
      version: WEBHOOK_VERSION,
      updatedBy: UPDATED_BY
    });

    const body = req.body;
    
    // Validate webhook object
    if (!body.object || body.object !== 'whatsapp_business_account') {
      logger.warning('❓ Invalid webhook object', { 
        object: body.object,
        requestId
      });
      return res.sendStatus(404);
    }

    // Handle incoming messages
    if (body.entry?.[0]?.changes?.[0]?.value?.messages) {
      await processIncomingMessage(body, requestId);
      return res.sendStatus(200);
    }

    // Handle message status updates
    if (body.entry?.[0]?.changes?.[0]?.value?.statuses) {
      await processMessageStatus(body, requestId);
      return res.sendStatus(200);
    }

    // Handle other webhook events
    logger.debug('📄 Other webhook event received', {
      requestId,
      eventType: body.entry?.[0]?.changes?.[0]?.field || 'unknown'
    });

    res.sendStatus(200);
  } catch (error) {
    const processingTime = Date.now() - startTime;
    logger.critical('💥 Webhook processing error', {
      error: error.message,
      stack: error.stack,
      requestId,
      processingTime,
      body: JSON.stringify(req.body).substring(0, 500),
      timestamp: new Date().toISOString()
    });
    
    res.status(500).json({
      error: 'Internal server error',
      requestId,
      timestamp: new Date().toISOString(),
      version: WEBHOOK_VERSION
    });
  }
}

/*
 * Process incoming WhatsApp message with comprehensive handling
 */
async function processIncomingMessage(body, requestId) {
  try {
    const messageData = body.entry[0].changes[0].value.messages[0];
    const metadata = body.entry[0].changes[0].value.metadata;
    const contactData = body.entry[0].changes[0].value.contacts?.[0];
    
    const phoneNumber = formatPhoneNumber(messageData.from);
    const displayName = contactData?.profile?.name || 'Unknown User';
    const messageType = messageData.type;
    const messageId = messageData.id;
    const botPhoneNumber = metadata.display_phone_number;
    
    logger.webhook('📨 Processing incoming message', {
      requestId,
      phoneNumber: phoneNumber.replace(/^91/, 'XXX-XXX-'),
      displayName,
      messageType,
      messageId,
      timestamp: new Date().toISOString()
    });

    // Rate limiting check
    if (await isRateLimited(phoneNumber)) {
      await handleRateLimit(phoneNumber, messageType);
      return;
    }

    // Log message preview for debugging
    logMessagePreview(messageData, messageType);

    // Ensure citizen exists in database
    await ensureCitizenExists(phoneNumber, displayName);

    // Mark message as read
    await markMessageAsRead(messageId);

    // Route message based on type
    switch (messageType) {
      case 'text':
        await handleTextMessage(messageData, phoneNumber, displayName, requestId);
        break;
      case 'audio':
        await handleAudioMessage(messageData, phoneNumber, displayName, requestId);
        break;
      case 'image':
        await handleImageMessage(messageData, phoneNumber, displayName, requestId);
        break;
      case 'location':
        await handleLocationMessage(messageData, phoneNumber, displayName, requestId);
        break;
      case 'interactive':
        await handleInteractiveMessage(messageData, phoneNumber, displayName, requestId);
        break;
      case 'document':
        await handleDocumentMessage(messageData, phoneNumber, displayName, requestId);
        break;
      case 'video':
        await handleVideoMessage(messageData, phoneNumber, displayName, requestId);
        break;
      case 'sticker':
        await handleStickerMessage(messageData, phoneNumber, displayName, requestId);
        break;
      case 'contacts':
        await handleContactMessage(messageData, phoneNumber, displayName, requestId);
        break;
      default:
        logger.warning(`❓ Unsupported message type: ${messageType}`, { requestId });
        await sendUnsupportedMessageResponse(phoneNumber, messageType);
        break;
    }

  } catch (error) {
    logger.critical('💥 Error processing incoming message', {
      error: error.message,
      stack: error.stack,
      requestId,
      timestamp: new Date().toISOString()
    });
    
    // Send emergency error response
    const phoneNumber = body.entry?.[0]?.changes?.[0]?.value?.messages?.[0]?.from;
    if (phoneNumber) {
      await sendEmergencyErrorMessage(formatPhoneNumber(phoneNumber));
    }
  }
}

/*
 * Handle text messages with comprehensive AI processing
 */
async function handleTextMessage(messageData, phoneNumber, displayName, requestId) {
  try {
    const messageText = sanitizeInput(messageData.text.body.trim(), 2000);
    const language = detectLanguage(messageText);
    
    logger.ai('📝 Processing text message', {
      phoneNumber: phoneNumber.replace(/^91/, 'XXX-XXX-'),
      language,
      textLength: messageText.length,
      requestId,
      timestamp: new Date().toISOString()
    });

    // Get bot mode status
    const botMode = await getCitizenBotMode(phoneNumber);

    // Analyze intent using AI
    const intentAnalysis = await analyzeIntent(messageText, phoneNumber);
    
    // Calculate ethical score
    const ethicalScore = await calculateEthicalScore(messageText);
    
    // Save incoming message with proper timestamps
    await saveChatMessage(phoneNumber, {
      messageId: messageData.id,
      sender: phoneNumber,
      senderName: displayName,
      receiver: 'pcmc_bot',
      messageType: 'text',
      content: messageText,
      intent: intentAnalysis.intent,
      context: intentAnalysis.context,
      conversationState: intentAnalysis.state,
      language,
      ethicalScore,
      confidence: intentAnalysis.confidence,
      botModeEnabled: botMode,
      requestId
    });

    // Update citizen's ethical score
    await updateCitizenEthicalScore(phoneNumber, ethicalScore);

    if (!botMode) {
      logger.info(`🔇 Bot mode disabled for ${phoneNumber.replace(/^91/, 'XXX-XXX-')}. Message stored only.`);
      return;
    }

    // Route based on intent
    switch (intentAnalysis.intent) {
      case 'complaint_status':
        await handleComplaintStatusQuery(phoneNumber, displayName, intentAnalysis, language, requestId);
        break;
      case 'complaint':
        await handleComplaintFlow(messageText, phoneNumber, displayName, intentAnalysis, language, requestId);
        break;
      case 'query':
        await handleQueryFlow(messageText, phoneNumber, displayName, intentAnalysis, language, requestId);
        break;
      case 'greeting':
        await handleGreetingFlow(messageText, phoneNumber, displayName, intentAnalysis, language, requestId);
        break;
      case 'small_talk':
        await handleSmallTalkFlow(messageText, phoneNumber, displayName, intentAnalysis, language, requestId);
        break;
      default:
        await handleGeneralConversation(messageText, phoneNumber, displayName, intentAnalysis, language, requestId);
        break;
    }

  } catch (error) {
    logger.critical('💥 Error handling text message', {
      error: error.message,
      phoneNumber: phoneNumber.replace(/^91/, 'XXX-XXX-'),
      requestId,
      stack: error.stack,
      timestamp: new Date().toISOString()
    });
    
    const errorMessage = language === 'marathi' 
      ? '😔 माफ करा, मी सध्या मदत करू शकत नाही. कृपया पुन्हा प्रयत्न करा.\n\n📞 तातडीच्या मदतीसाठी: 020-27475000\n\n🏛️ *PCMC सेवा*'
      : '😔 Sorry, I cannot help right now. Please try again.\n\n📞 For urgent help: 020-27475000\n\n🏛️ *PCMC Service*';
    await sendText(phoneNumber, errorMessage);
  }
}

/*
 * FEATURE 1: Handle complaint status queries with detailed information
 */
async function handleComplaintStatusQuery(phoneNumber, displayName, intentAnalysis, language, requestId) {
  try {
    logger.complaint('📋 Processing complaint status query', {
      phoneNumber: phoneNumber.replace(/^91/, 'XXX-XXX-'),
      language,
      requestId,
      timestamp: new Date().toISOString()
    });

    // Get user's complaints
    const complaints = await getUserComplaintStatus(phoneNumber);

    if (complaints.length === 0) {
      const noComplaintsMessage = language === 'marathi'
        ? `📋 *तुमच्या तक्रारींची स्थिती*\n\n👤 *नागरिक:* ${displayName}\n📱 *फोन:* ${phoneNumber.replace(/^91/, 'XXX-XXX-')}\n\n❌ *तुमच्या नावे कोणत्याही तक्रारी नोंदवलेल्या नाहीत.*\n\n💡 *नवीन तक्रार नोंदवण्यासाठी:*\nतुमची समस्या टाइप करा किंवा फोटो पाठवा\n\n📞 *मदतीसाठी:* 020-27475000\n\n🏛️ *PCMC सेवा*`
        : `📋 *Your Complaint Status*\n\n👤 *Citizen:* ${displayName}\n📱 *Phone:* ${phoneNumber.replace(/^91/, 'XXX-XXX-')}\n\n❌ *No complaints found in your name.*\n\n💡 *To register new complaint:*\nType your issue or send a photo\n\n📞 *For help:* 020-27475000\n\n🏛️ *PCMC Service*`;
      
      await sendText(phoneNumber, noComplaintsMessage);
      return;
    }

    // Format complaints status with enhanced display
    const statusMessage = formatComplaintStatusMessage(complaints, displayName, phoneNumber, language);
    await sendText(phoneNumber, statusMessage);

    // Save status query response
    await saveChatMessage(phoneNumber, {
      messageId: generateTicketId(8),
      sender: 'pcmc_bot',
      senderName: 'PCMC Assistant',
      receiver: phoneNumber,
      messageType: 'text',
      content: statusMessage,
      intent: 'status_response',
      context: 'complaint_status',
      conversationState: 'status_provided',
      language,
      ethicalScore: 10,
      botModeEnabled: true,
      aiMetadata: {
        complaintsCount: complaints.length,
        queryType: 'status_check'
      },
      requestId
    });

    logger.success('✅ Complaint status query completed', {
      phoneNumber: phoneNumber.replace(/^91/, 'XXX-XXX-'),
      complaintsFound: complaints.length,
      requestId,
      timestamp: new Date().toISOString()
    });

  } catch (error) {
    logger.critical('💥 Error handling complaint status query', {
      error: error.message,
      phoneNumber: phoneNumber.replace(/^91/, 'XXX-XXX-'),
      requestId,
      stack: error.stack,
      timestamp: new Date().toISOString()
    });
    
    const errorMessage = language === 'marathi'
      ? '😔 तक्रार स्थिती मिळविताना समस्या आली. कृपया पुन्हा प्रयत्न करा.'
      : '😔 Error retrieving complaint status. Please try again.';
    await sendText(phoneNumber, errorMessage);
  }
}

/*
 * Format complaint status message with progress bars and detailed information
 */
function formatComplaintStatusMessage(complaints, displayName, phoneNumber, language) {
  const isMarathi = language === 'marathi';
  
  // Header
  let message = isMarathi 
    ? `📋 *तुमच्या तक्रारींची स्थिती* | *Your Complaint Status*\n\n👤 *नागरिक:* ${displayName}\n📱 *एकूण तक्रारी:* ${complaints.length}\n📅 *तयार केले:* ${new Date().toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' })}\n\n`
    : `📋 *Your Complaint Status*\n\n👤 *Citizen:* ${displayName}\n📱 *Total Complaints:* ${complaints.length}\n📅 *Generated:* ${new Date().toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' })}\n\n`;

  // Process each complaint
  complaints.forEach((complaint, index) => {
    const statusEmoji = getStatusEmoji(complaint.status);
    const priorityEmoji = getPriorityEmoji(complaint.priority);
    const progressBar = getProgressBar(complaint.workflow.completionPercentage);
    const createdDate = formatDate(complaint.createdAt);
    
    message += `${index + 1}. ${statusEmoji} *${complaint.category}*\n`;
    message += `   🎫 *${isMarathi ? 'तिकीट' : 'Ticket'}:* ${complaint.ticketId}\n`;
    message += `   🏛️ *${isMarathi ? 'विभाग' : 'Department'}:* ${complaint.department}\n`;
    message += `   ${priorityEmoji} *${isMarathi ? 'प्राधान्यता' : 'Priority'}:* ${complaint.priority.toUpperCase()}\n`;
    message += `   📈 *${isMarathi ? 'प्रगती' : 'Progress'}:* ${progressBar} ${complaint.workflow.completionPercentage}%\n`;
    message += `   📝 "${complaint.description}"\n`;
    message += `   📅 *${isMarathi ? 'नोंदवले' : 'Registered'}:* ${createdDate}\n`;
    
    if (complaint.estimatedResolutionTime) {
      message += `   ⏱️ *${isMarathi ? 'अपेक्षित' : 'Expected'}:* ${complaint.estimatedResolutionTime} ${isMarathi ? 'तास' : 'hours'}\n`;
    }
    
    message += `\n`;
  });

  // Footer
  message += isMarathi
    ? `❓ *तक्रारीबद्दल प्रश्न?* तिकीट क्रमांक द्या\n❓ *Questions about complaint?* Provide ticket number\n\n📞 *मदतीसाठी:* 020-27475000\n\n🏛️ *PCMC सेवा*`
    : `❓ *Questions about complaint?* Provide ticket number\n\n📞 *For help:* 020-27475000\n\n🏛️ *PCMC Service*`;

  return message;
}

/*
 * Handle complaint registration flow with duplicate detection
 */
/**
 * ENHANCED: Handle complaint registration flow with better duplicate detection
 */
async function handleComplaintFlow(messageText, phoneNumber, displayName, intentAnalysis, language, requestId, imageUrl = null) {
  try {
    logger.complaint('📝 Processing enhanced complaint registration', {
      phoneNumber: phoneNumber.replace(/^91/, 'XXX-XXX-'),
      language,
      descriptionLength: messageText.length,
      hasImage: !!imageUrl,
      requestId
    });

    // ENHANCED: Check for duplicate complaints with location and image
    const duplicateCheck = await checkDuplicateComplaint(messageText, phoneNumber, null, imageUrl);
    
    if (duplicateCheck.isDuplicate) {
      logger.complaint('🔄 Enhanced duplicate complaint detected', {
        phoneNumber: phoneNumber.replace(/^91/, 'XXX-XXX-'),
        existingTicket: duplicateCheck.ticketId,
        similarity: duplicateCheck.similarity,
        confidence: duplicateCheck.confidence,
        distance: duplicateCheck.distance,
        requestId
      });

      // Enhanced duplicate message with detailed breakdown
      const duplicateMessage = language === 'marathi'
        ? `🔄 **समान तक्रार आधी नोंदवली आहे**\n\n🎫 **अस्तित्वात असलेली तिकीट:** ${duplicateCheck.ticketId}\n📊 **स्थिती:** ${duplicateCheck.status}\n🎯 **समानता:** ${Math.round(duplicateCheck.similarity * 100)}%\n🎯 **विश्वसनीयता:** ${Math.round(duplicateCheck.confidence * 100)}%\n🏛️ **विभाग:** ${duplicateCheck.department}\n${duplicateCheck.distance ? `📍 **अंतर:** ${Math.round(duplicateCheck.distance * 1000)}m\n` : ''}\n📋 **मूळ तक्रार:** "${duplicateCheck.originalComplaint}"\n\n📊 **तपशीलवार विश्लेषण:**\n${duplicateCheck.explanation}\n\n✅ आम्ही तुम्हाला अपडेट यादीत जोडले आहे. तुम्हाला या तक्रारीच्या स्थितीबद्दल अपडेट मिळतील.\n\n❓ **वेगळी तक्रार नोंदवायची आहे का?** कृपया अधिक तपशील किंवा वेगळे स्थान द्या.\n\n🏛️ **PCMC सेवा**`
        : `🔄 **Similar complaint already registered**\n\n🎫 **Existing Ticket:** ${duplicateCheck.ticketId}\n📊 **Status:** ${duplicateCheck.status}\n🎯 **Similarity:** ${Math.round(duplicateCheck.similarity * 100)}%\n🎯 **Confidence:** ${Math.round(duplicateCheck.confidence * 100)}%\n🏛️ **Department:** ${duplicateCheck.department}\n${duplicateCheck.distance ? `📍 **Distance:** ${Math.round(duplicateCheck.distance * 1000)}m\n` : ''}\n📋 **Original Complaint:** "${duplicateCheck.originalComplaint}"\n\n📊 **Detailed Analysis:**\n${duplicateCheck.explanation}\n\n✅ We've added you to the updates list. You'll receive updates about this complaint's progress.\n\n❓ **Want to register different complaint?** Please provide more details or different location.\n\n🏛️ **PCMC Service**`;

      await sendTextMessage(phoneNumber, duplicateMessage);
      
      // Save enhanced duplicate detection response
      await saveChatMessage(phoneNumber, {
        messageId: generateTicketId(8),
        sender: 'pcmc_bot',
        senderName: 'PCMC Assistant',
        receiver: phoneNumber,
        messageType: 'text',
        content: duplicateMessage,
        intent: 'duplicate_detected',
        context: 'complaint_registration',
        conversationState: 'duplicate_handled',
        language,
        ethicalScore: 10,
        botModeEnabled: true,
        aiMetadata: {
          duplicateTicketId: duplicateCheck.ticketId,
          similarity: duplicateCheck.similarity,
          confidence: duplicateCheck.confidence,
          breakdown: duplicateCheck.breakdown,
          originalComplaint: duplicateCheck.originalComplaint,
          analysisType: 'enhanced_multi_parameter'
        },
        requestId
      });

      return;
    }

    // No duplicate found - proceed with normal complaint creation
    const draftComplaint = await createDraftComplaint(messageText, phoneNumber, intentAnalysis, imageUrl);
    
    // Send confirmation request with detailed information
    await sendComplaintConfirmation(phoneNumber, draftComplaint, language);

    logger.success('✅ Enhanced complaint flow initiated successfully', {
      phoneNumber: phoneNumber.replace(/^91/, 'XXX-XXX-'),
      complaintId: draftComplaint.id,
      department: draftComplaint.department,
      priority: draftComplaint.priority,
      duplicateCheckScore: duplicateCheck.highestScore || 0,
      requestId
    });

  } catch (error) {
    logger.critical('💥 Error in enhanced complaint flow', {
      error: error.message,
      phoneNumber: phoneNumber.replace(/^91/, 'XXX-XXX-'),
      requestId,
      stack: error.stack
    });
    
    const errorMessage = language === 'marathi'
      ? '😔 तक्रार नोंदवताना समस्या आली. कृपया पुन्हा प्रयत्न करा.'
      : '😔 Error registering complaint. Please try again.';
    await sendTextMessage(phoneNumber, errorMessage);
  }
}

/*
 * FIXED: Send complaint confirmation with enhanced details
 */
async function sendComplaintConfirmation(phoneNumber, complaintData, language) {
  try {
    const isMarathi = language === 'marathi';
    
    const confirmationMessage = {
      messaging_product: 'whatsapp',
      recipient_type: 'individual',
      to: phoneNumber,
      type: 'interactive',
      interactive: {
        type: 'button',
        body: {
          text: isMarathi
            ? `🏛️ *PCMC तक्रार पुष्टीकरण*\n\n📋 *तक्रार:* ${complaintData.description.substring(0, 100)}${complaintData.description.length > 100 ? '...' : ''}\n\n🏛️ *विभाग:* ${complaintData.department}\n🔴 *प्राधान्यता:* ${complaintData.priority.toUpperCase()}\n📊 *प्रकार:* ${complaintData.category}\n⏱️ *अपेक्षित वेळ:* ${complaintData.estimatedResolutionTime} तास\n\nही तक्रार अधिकृत रूपात नोंदवायची आहे का?\n\n⚠️ *पुढील पायरी:* तुमचे अचूक स्थान शेअर करणे आवश्यक आहे.`
            : `🏛️ *PCMC Complaint Confirmation*\n\n📋 *Complaint:* ${complaintData.description.substring(0, 100)}${complaintData.description.length > 100 ? '...' : ''}\n\n🏛️ *Department:* ${complaintData.department}\n🔴 *Priority:* ${complaintData.priority.toUpperCase()}\n📊 *Category:* ${complaintData.category}\n⏱️ *Expected Time:* ${complaintData.estimatedResolutionTime} hours\n\nWould you like to register this as an official complaint?\n\n⚠️ *Next Step:* You'll need to share your exact location.`
        },
        action: {
          buttons: [
            {
              type: 'reply',
              reply: {
                id: `confirm_complaint_${complaintData.id}`,
                title: isMarathi ? '✅ पुष्टी करा' : '✅ Confirm'
              }
            },
            {
              type: 'reply',
              reply: {
                id: `cancel_complaint_${complaintData.id}`,
                title: isMarathi ? '❌ रद्द करा' : '❌ Cancel'
              }
            }
          ]
        }
      }
    };

    // ✅ FIXED: Use sendInteractive instead of sendInteractiveMessage
    await sendInteractive(confirmationMessage);
    
    logger.success('✅ Complaint confirmation sent successfully', {
      phoneNumber: phoneNumber.replace(/^91/, 'XXX-XXX-'),
      complaintId: complaintData.id,
      department: complaintData.department,
      timestamp: new Date().toISOString()
    });
    
  } catch (error) {
    logger.critical('🚨 CRITICAL: 💥 Error sending complaint confirmation', {
      version: WEBHOOK_VERSION,
      environment: process.env.NODE_ENV || 'development',
      error: error.message,
      phoneNumber: phoneNumber.replace(/^91/, 'XXX-XXX-'),
      complaintId: complaintData.id,
      stack: error.stack,
      timestamp: new Date().toISOString(),
      updatedBy: UPDATED_BY
    });
    
    // Fallback: Send text message instead of interactive
    const fallbackMessage = language === 'marathi'
      ? `🏛️ *PCMC तक्रार पुष्टीकरण*\n\n📋 ${complaintData.description.substring(0, 100)}...\n\n✅ "होय" टाइप करा - तक्रार नोंदवण्यासाठी\n❌ "नाही" टाइप करा - रद्द करण्यासाठी\n\n🏛️ *PCMC सेवा*`
      : `🏛️ *PCMC Complaint Confirmation*\n\n📋 ${complaintData.description.substring(0, 100)}...\n\n✅ Type "Yes" - to register complaint\n❌ Type "No" - to cancel\n\n🏛️ *PCMC Service*`;
    
    await sendText(phoneNumber, fallbackMessage);
  }
}

/*
 * Handle audio messages with transcription and processing
 */
async function handleAudioMessage(messageData, phoneNumber, displayName, requestId) {
  try {
    logger.ai('🎙️ Processing audio message', {
      phoneNumber: phoneNumber.replace(/^91/, 'XXX-XXX-'),
      mediaId: messageData.audio.id,
      duration: messageData.audio.voice ? 'voice_note' : 'audio_file',
      requestId
    });

    const botMode = await getCitizenBotMode(phoneNumber);
    let language = 'auto'; // FIXED: Declare language variable
    
    try {
      // Download and transcribe audio
      const mediaUrl = await getMediaUrl(messageData.audio.id);
      const localPath = await downloadAudioFile(mediaUrl, messageData.audio.id);
      const transcript = await transcribeAudio(localPath);
      
      logger.ai('✅ Audio transcribed successfully', {
        phoneNumber: phoneNumber.replace(/^91/, 'XXX-XXX-'),
        transcriptLength: transcript.length,
        requestId
      });

      // FIXED: Detect language from transcript
      language = detectLanguage(transcript);
      const ethicalScore = await calculateEthicalScore(transcript);
      const intentAnalysis = await analyzeIntent(transcript, phoneNumber);

      // Save audio message
      await saveChatMessage(phoneNumber, {
        messageId: messageData.id,
        sender: phoneNumber,
        senderName: displayName,
        receiver: 'pcmc_bot',
        messageType: 'audio',
        content: transcript,
        audioMetadata: {
          mediaId: messageData.audio.id,
          mimeType: messageData.audio.mime_type,
          voice: messageData.audio.voice || false
        },
        intent: intentAnalysis.intent,
        context: intentAnalysis.context,
        conversationState: intentAnalysis.state,
        language,
        ethicalScore,
        confidence: intentAnalysis.confidence,
        botModeEnabled: botMode,
        requestId
      });

      // Update citizen's ethical score
      await updateCitizenEthicalScore(phoneNumber, ethicalScore);

      // Clean up audio file
      if (fs.existsSync(localPath)) {
        fs.unlinkSync(localPath);
      }

      if (!botMode) {
        logger.info(`🔇 Bot mode disabled for ${phoneNumber.replace(/^91/, 'XXX-XXX-')}. Audio transcribed and stored only.`);
        return;
      }

      // Process transcribed content based on intent
      switch (intentAnalysis.intent) {
        case 'complaint_status':
          await handleComplaintStatusQuery(phoneNumber, displayName, intentAnalysis, language, requestId);
          break;
        case 'complaint':
          await handleComplaintFlow(transcript, phoneNumber, displayName, intentAnalysis, language, requestId);
          break;
        default:
          await handleGeneralConversation(transcript, phoneNumber, displayName, intentAnalysis, language, requestId);
          break;
      }

    } catch (audioError) {
      logger.critical('💥 Error processing audio', {
        error: audioError.message,
        phoneNumber: phoneNumber.replace(/^91/, 'XXX-XXX-'),
        mediaId: messageData.audio.id,
        requestId,
        stack: audioError.stack
      });
      
      // FIXED: Use proper language variable
      const errorMessage = language === 'marathi'
        ? '😔 ऑडिओ प्रक्रिया करताना समस्या आली. कृपया मजकूर संदेश पाठवा किंवा पुन्हा प्रयत्न करा.\n\n🏛️ **PCMC सेवा**'
        : '😔 Error processing audio. Please send text message or try again.\n\n🏛️ **PCMC Service**';
      await sendTextMessage(phoneNumber, errorMessage);
    }

  } catch (error) {
    logger.critical('💥 Error handling audio message', {
      error: error.message,
      phoneNumber: phoneNumber.replace(/^91/, 'XXX-XXX-'),
      requestId,
      stack: error.stack
    });
    
    // Fallback error message
    const fallbackMessage = '😔 Error processing your audio. Please try sending text message.\n\n📞 For urgent help: 020-27475000\n\n🏛️ **PCMC Service**';
    
    try {
      await sendTextMessage(phoneNumber, fallbackMessage);
    } catch (sendError) {
      logger.critical('💥 Failed to send error message', {
        error: sendError.message,
        phoneNumber: phoneNumber.replace(/^91/, 'XXX-XXX-')
      });
    }
  }
}

/*
 * Handle image messages with AI analysis
 */
async function handleImageMessage(messageData, phoneNumber, displayName, requestId) {
  try {
    logger.ai('🖼️ Processing image message', {
      phoneNumber: phoneNumber.replace(/^91/, 'XXX-XXX-'),
      mediaId: messageData.image.id,
      hasCaption: !!messageData.image.caption,
      requestId
    });

    const botMode = await getCitizenBotMode(phoneNumber);
    let language = 'auto'; // FIXED: Declare language variable
    
    try {
      // Download and upload image
      const mediaUrl = await getMediaUrl(messageData.image.id);
      const imageUrl = await downloadAndUploadImage(mediaUrl, messageData.image.id);
      
      // Analyze image content with AI
      const imageAnalysis = await analyzeImageContent(imageUrl);
      const caption = messageData.image.caption || '';
      const fullContent = caption ? `${caption}\n\nImage Analysis: ${imageAnalysis}` : imageAnalysis;
      
      logger.ai('✅ Image analyzed successfully', {
        phoneNumber: phoneNumber.replace(/^91/, 'XXX-XXX-'),
        analysisLength: imageAnalysis.length,
        hasCaption: !!caption,
        requestId
      });

      // FIXED: Detect language from content
      language = detectLanguage(fullContent);
      const ethicalScore = await calculateEthicalScore(fullContent);
      const intentAnalysis = await analyzeIntent(fullContent, phoneNumber);

      // Save image message
      await saveChatMessage(phoneNumber, {
        messageId: messageData.id,
        sender: phoneNumber,
        senderName: displayName,
        receiver: 'pcmc_bot',
        messageType: 'image',
        content: fullContent,
        imageUrl,
        imageMetadata: {
          mediaId: messageData.image.id,
          mimeType: messageData.image.mime_type,
          caption: caption || null,
          sha256: messageData.image.sha256 || null
        },
        intent: intentAnalysis.intent,
        context: intentAnalysis.context,
        conversationState: intentAnalysis.state,
        language,
        ethicalScore,
        confidence: intentAnalysis.confidence,
        botModeEnabled: botMode,
        requestId
      });

      // Update citizen's ethical score
      await updateCitizenEthicalScore(phoneNumber, ethicalScore);

      if (!botMode) {
        logger.info(`🔇 Bot mode disabled for ${phoneNumber.replace(/^91/, 'XXX-XXX-')}. Image analyzed and stored only.`);
        return;
      }

      // Process image content based on intent
      switch (intentAnalysis.intent) {
        case 'complaint':
          await handleComplaintFlow(fullContent, phoneNumber, displayName, intentAnalysis, language, requestId, imageUrl);
          break;
        default:
          await handleGeneralConversation(fullContent, phoneNumber, displayName, intentAnalysis, language, requestId);
          break;
      }

    } catch (imageError) {
      logger.critical('💥 Error processing image', {
        error: imageError.message,
        phoneNumber: phoneNumber.replace(/^91/, 'XXX-XXX-'),
        mediaId: messageData.image.id,
        requestId,
        stack: imageError.stack
      });
      
      // FIXED: Use proper language variable
      const errorMessage = language === 'marathi'
        ? '😔 फोटो प्रक्रिया करताना समस्या आली. कृपया पुन्हा प्रयत्न करा.\n\n🏛️ **PCMC सेवा**'
        : '😔 Error processing image. Please try again.\n\n🏛️ **PCMC Service**';
      await sendTextMessage(phoneNumber, errorMessage);
    }

  } catch (error) {
    logger.critical('💥 Error handling image message', {
      error: error.message,
      phoneNumber: phoneNumber.replace(/^91/, 'XXX-XXX-'),
      requestId,
      stack: error.stack
    });
    
    // Fallback error message
    const fallbackMessage = '😔 Error processing your image. Please try sending text message.\n\n📞 For urgent help: 020-27475000\n\n🏛️ **PCMC Service**';
    
    try {
      await sendTextMessage(phoneNumber, fallbackMessage);
    } catch (sendError) {
      logger.critical('💥 Failed to send error message', {
        error: sendError.message,
        phoneNumber: phoneNumber.replace(/^91/, 'XXX-XXX-')
      });
    }
  }
}

/*
 * Handle location messages with complaint confirmation
 */
async function handleLocationMessage(messageData, phoneNumber, displayName, requestId) {
  try {
    const latitude = messageData.location.latitude;
    const longitude = messageData.location.longitude;
    const locationName = messageData.location.name || null;
    
    logger.complaint('📍 Processing location message', {
      phoneNumber: phoneNumber.replace(/^91/, 'XXX-XXX-'),
      latitude,
      longitude,
      hasName: !!locationName,
      requestId,
      timestamp: new Date().toISOString()
    });

    try {
      // Geocode coordinates to address
      const address = await geocodeAddress(latitude, longitude);
      
      const locationData = {
        latitude,
        longitude,
        address,
        name: locationName,
        source: 'whatsapp_location',
        accuracy: messageData.location.accuracy || null
      };

      // Save location message
      await saveChatMessage(phoneNumber, {
        messageId: messageData.id,
        sender: phoneNumber,
        senderName: displayName,
        receiver: 'pcmc_bot',
        messageType: 'location',
        content: `Location shared: ${address}`,
        location: locationData,
        intent: 'location_sharing',
        context: 'complaint_location',
        conversationState: 'location_received',
        language: 'auto',
        ethicalScore: 9,
        botModeEnabled: true,
        requestId
      });

      // Check for pending draft complaints requiring location
      const pendingComplaint = await getPendingComplaintForUser(phoneNumber);
      
      if (pendingComplaint) {
        // Confirm complaint with location
        const ticketId = await confirmComplaint(pendingComplaint.id, locationData);
        
        const language = detectLanguage(pendingComplaint.description);
        const successMessage = language === 'marathi'
          ? `✅ *तक्रार यशस्वीरित्या नोंदवली!*\n\n🎫 *तिकीट क्रमांक:* ${ticketId}\n🏛️ *विभाग:* ${pendingComplaint.department}\n🔴 *प्राधान्यता:* ${pendingComplaint.priority}\n📍 *स्थान:* ${address}\n\n📋 *तक्रार:* ${pendingComplaint.description.substring(0, 100)}${pendingComplaint.description.length > 100 ? '...' : ''}\n\n⏱️ *अपेक्षित कार्यवाही:* ${pendingComplaint.estimatedResolutionTime} तास\n\n✅ PCMC तुमची तक्रार पाहील आणि योग्य कार्यवाही करेल. धन्यवाद!\n\n🏛️ *PCMC सेवा*`
          : `✅ *Complaint registered successfully!*\n\n🎫 *Ticket ID:* ${ticketId}\n🏛️ *Department:* ${pendingComplaint.department}\n🔴 *Priority:* ${pendingComplaint.priority}\n📍 *Location:* ${address}\n\n📋 *Complaint:* ${pendingComplaint.description.substring(0, 100)}${pendingComplaint.description.length > 100 ? '...' : ''}\n\n⏱️ *Expected Action:* ${pendingComplaint.estimatedResolutionTime} hours\n\n✅ PCMC will review your complaint and take appropriate action. Thank you!\n\n🏛️ *PCMC Service*`;
        
        await sendText(phoneNumber, successMessage);
        
        logger.success('✅ Complaint confirmed with location', {
          phoneNumber: phoneNumber.replace(/^91/, 'XXX-XXX-'),
          ticketId,
          complaintId: pendingComplaint.id,
          department: pendingComplaint.department,
          requestId,
          timestamp: new Date().toISOString()
        });
        
      } else {
        // No pending complaint, acknowledge location
        const acknowledgmentMessage = `📍 *स्थान प्राप्त झाले* | *Location Received*\n\n📍 ${address}\n\n✅ तुमचे स्थान नोंदवले आहे.\n✅ Your location has been recorded.\n\n❓ *PCMC ची मदत कशी करू शकते?*\n❓ *How can PCMC help you today?*\n\n🏛️ *PCMC सेवा*`;
        
        await sendText(phoneNumber, acknowledgmentMessage);
      }

    } catch (locationError) {
      logger.critical('💥 Error processing location', {
        error: locationError.message,
        phoneNumber: phoneNumber.replace(/^91/, 'XXX-XXX-'),
        latitude,
        longitude,
        requestId,
        timestamp: new Date().toISOString()
      });
      
      const errorMessage = `😔 *स्थान प्रक्रिया त्रुटी* | *Location Processing Error*\n\nकृपया पुन्हा प्रयत्न करा.\nPlease try again.\n\n🏛️ *PCMC सेवा*`;
      await sendText(phoneNumber, errorMessage);
    }

  } catch (error) {
    logger.critical('💥 Error handling location message', {
      error: error.message,
      phoneNumber: phoneNumber.replace(/^91/, 'XXX-XXX-'),
      requestId,
      stack: error.stack,
      timestamp: new Date().toISOString()
    });
  }
}

/*
 * Handle interactive messages (buttons, lists, etc.)
 */
async function handleInteractiveMessage(messageData, phoneNumber, displayName, requestId) {
  try {
    logger.webhook('🔘 Processing interactive message', {
      phoneNumber: phoneNumber.replace(/^91/, 'XXX-XXX-'),
      type: messageData.interactive.type,
      requestId,
      timestamp: new Date().toISOString()
    });

    if (messageData.interactive.type === 'button_reply') {
      const buttonId = messageData.interactive.button_reply.id;
      const buttonTitle = messageData.interactive.button_reply.title;
      
      logger.debug('🔘 Button clicked', { buttonId, buttonTitle, requestId });
      
      // Save interactive message
      await saveChatMessage(phoneNumber, {
        messageId: messageData.id,
        sender: phoneNumber,
        senderName: displayName,
        receiver: 'pcmc_bot',
        messageType: 'interactive',
        content: `Button clicked: ${buttonTitle}`,
        interactiveData: { 
          type: 'button_reply',
          buttonId, 
          buttonTitle 
        },
        intent: 'button_click',
        context: 'interactive_response',
        conversationState: 'button_clicked',
        language: 'auto',
        ethicalScore: 9,
        botModeEnabled: true,
        requestId
      });

      // Handle specific button actions
      if (buttonId.startsWith('confirm_complaint_')) {
        const complaintId = buttonId.replace('confirm_complaint_', '');
        await handleComplaintConfirmation(complaintId, phoneNumber, requestId);
      } else if (buttonId.startsWith('cancel_complaint_')) {
        const complaintId = buttonId.replace('cancel_complaint_', '');
        await handleComplaintCancellation(complaintId, phoneNumber, requestId);
      } else {
        // Generic button response
        const response = `✅ *बटण निवडले* | *Button Selected*\n\n"${buttonTitle}"\n\nकाय मदत करू शकतो?\nWhat can I help with?\n\n🏛️ *PCMC सेवा*`;
        await sendText(phoneNumber, response);
      }

    } else if (messageData.interactive.type === 'list_reply') {
      const listId = messageData.interactive.list_reply.id;
      const listTitle = messageData.interactive.list_reply.title;
      
      await handleListSelection(listId, listTitle, phoneNumber, displayName, requestId);
      
    } else {
      logger.warning('❓ Unsupported interactive type', {
        type: messageData.interactive.type,
        requestId
      });
    }

  } catch (error) {
    logger.critical('💥 Error handling interactive message', {
      error: error.message,
      phoneNumber: phoneNumber.replace(/^91/, 'XXX-XXX-'),
      requestId,
      stack: error.stack,
      timestamp: new Date().toISOString()
    });
  }
}

/*
 * Handle complaint confirmation
 */
async function handleComplaintConfirmation(complaintId, phoneNumber, requestId) {
  try {
    logger.complaint('✅ Processing complaint confirmation', { 
      complaintId, 
      phoneNumber: phoneNumber.replace(/^91/, 'XXX-XXX-'),
      requestId,
      timestamp: new Date().toISOString()
    });
    
    // Get draft complaint
    const complaintRef = admin.firestore().collection('complaints').doc(complaintId);
    const complaintDoc = await complaintRef.get();
    
    if (!complaintDoc.exists) {
      await sendText(phoneNumber, 
        '❌ तक्रार सापडली नाही. कृपया पुन्हा प्रयत्न करा.\n❌ Complaint not found. Please try again.\n\n🏛️ *PCMC Service*'
      );
      return;
    }

    const complaintData = complaintDoc.data();
    const language = detectLanguage(complaintData.description);
    
    // Request WhatsApp location sharing
    const locationMessage = language === 'marathi'
      ? `✅ *तक्रार पुष्ट केली!*\n\n📍 *आता कृपया तुमचे अचूक स्थान शेअर करा:*\n\n📱 *WhatsApp मध्ये:*\n1️⃣ 📎 (attach) बटणावर क्लिक करा\n2️⃣ "Location" निवडा\n3️⃣ "Send your current location" निवडा\n\n🔄 *किंवा*\nमेसेज बॉक्समध्ये 📍 आयकॉनवर क्लिक करा\n\n⚠️ *महत्वाचे:* कृपया फक्त WhatsApp चे location feature वापरा\n\n🎯 *का आवश्यक आहे?*\n• अचूक स्थान ओळखण्यासाठी\n• योग्य विभागाला पाठवण्यासाठी\n• जलद कार्यवाहीसाठी\n\n🏛️ *PCMC सेवा*`
      : `✅ *Complaint confirmed!*\n\n📍 *Now please share your exact location:*\n\n📱 *In WhatsApp:*\n1️⃣ Click 📎 (attach) button\n2️⃣ Select "Location"\n3️⃣ Choose "Send your current location"\n\n🔄 *Or*\nClick 📍 icon in message box\n\n⚠️ *Important:* Please only use WhatsApp's location feature\n\n🎯 *Why needed?*\n• To identify exact location\n• To route to correct department\n• For faster action\n\n🏛️ *PCMC Service*`;

    await sendText(phoneNumber, locationMessage);
    
    logger.success('✅ Complaint confirmation processed - location request sent', { 
      complaintId, 
      requestId,
      timestamp: new Date().toISOString()
    });

  } catch (error) {
    logger.critical('💥 Error confirming complaint', { 
      error: error.message, 
      complaintId, 
      phoneNumber: phoneNumber.replace(/^91/, 'XXX-XXX-'),
      requestId,
      timestamp: new Date().toISOString()
    });
  }
}

/*
 * Handle complaint cancellation
 */
async function handleComplaintCancellation(complaintId, phoneNumber, requestId) {
  try {
    logger.complaint('❌ Processing complaint cancellation', { 
      complaintId, 
      phoneNumber: phoneNumber.replace(/^91/, 'XXX-XXX-'),
      requestId,
      timestamp: new Date().toISOString()
    });
    
    await cancelComplaint(complaintId);
    
    await sendText(phoneNumber,
      `❌ *तक्रार रद्द केली* | *Complaint Cancelled*\n\n✅ तुमची तक्रार यशस्वीरित्या रद्द केली गेली.\n✅ Your complaint has been successfully cancelled.\n\n💡 *नवीन तक्रार नोंदवण्यासाठी:* तुमची समस्या टाइप करा\n💡 *To register new complaint:* Type your issue\n\n❓ *इतर प्रश्नांसाठी आम्ही इथे आहोत*\n❓ *We're here for any other questions*\n\n🏛️ *PCMC सेवा*`
    );
    
    logger.success('✅ Complaint cancellation processed', { 
      complaintId, 
      requestId,
      timestamp: new Date().toISOString()
    });

  } catch (error) {
    logger.critical('💥 Error cancelling complaint', { 
      error: error.message, 
      complaintId, 
      phoneNumber: phoneNumber.replace(/^91/, 'XXX-XXX-'),
      requestId,
      timestamp: new Date().toISOString()
    });
  }
}

/*
 * Handle document messages
 */
async function handleDocumentMessage(messageData, phoneNumber, displayName, requestId) {
  try {
    const documentData = messageData.document;
    
    logger.debug('📄 Document message received', {
      phoneNumber: phoneNumber.replace(/^91/, 'XXX-XXX-'),
      filename: documentData.filename || 'unnamed',
      mimeType: documentData.mime_type,
      requestId,
      timestamp: new Date().toISOString()
    });

    // Save document message
    await saveChatMessage(phoneNumber, {
      messageId: messageData.id,
      sender: phoneNumber,
      senderName: displayName,
      receiver: 'pcmc_bot',
      messageType: 'document',
      content: `Document shared: ${documentData.filename || 'Document'}`,
      documentMetadata: {
        mediaId: documentData.id,
        filename: documentData.filename || null,
        mimeType: documentData.mime_type,
        caption: documentData.caption || null
      },
      intent: 'document_sharing',
      context: 'file_upload',
      conversationState: 'document_received',
      language: 'auto',
      ethicalScore: 8,
      botModeEnabled: true,
      requestId
    });

    const response = `📄 *दस्तऐवज प्राप्त झाला* | *Document Received*\n\n📎 *फाइल:* ${documentData.filename || 'Document'}\n\nधन्यवाद! सध्या आम्ही दस्तऐवज प्रक्रिया समर्थित करत नाही.\nThank you! We currently don't support document processing.\n\n💡 *कृपया तुमची समस्या मजकूर म्हणून लिहा*\n💡 *Please describe your issue as text*\n\n🏛️ *PCMC सेवा*`;
    
    await sendText(phoneNumber, response);

  } catch (error) {
    logger.critical('💥 Error handling document message', {
      error: error.message,
      phoneNumber: phoneNumber.replace(/^91/, 'XXX-XXX-'),
      requestId,
      timestamp: new Date().toISOString()
    });
  }
}

/*
 * Handle video messages
 */
async function handleVideoMessage(messageData, phoneNumber, displayName, requestId) {
  try {
    const videoData = messageData.video;
    
    logger.debug('🎥 Video message received', {
      phoneNumber: phoneNumber.replace(/^91/, 'XXX-XXX-'),
      mimeType: videoData.mime_type,
      hasCaption: !!videoData.caption,
      requestId,
      timestamp: new Date().toISOString()
    });

    // Save video message
    await saveChatMessage(phoneNumber, {
      messageId: messageData.id,
      sender: phoneNumber,
      senderName: displayName,
      receiver: 'pcmc_bot',
      messageType: 'video',
      content: `Video shared${videoData.caption ? `: ${videoData.caption}` : ''}`,
      videoMetadata: {
        mediaId: videoData.id,
        mimeType: videoData.mime_type,
        caption: videoData.caption || null
      },
      intent: 'video_sharing',
      context: 'media_upload',
      conversationState: 'video_received',
      language: 'auto',
      ethicalScore: 8,
      botModeEnabled: true,
      requestId
    });

    const response = `🎥 *व्हिडिओ प्राप्त झाला* | *Video Received*\n\nधन्यवाद! सध्या आम्ही व्हिडिओ प्रक्रिया समर्थित करत नाही.\nThank you! We currently don't support video processing.\n\n💡 *कृपया तुमची समस्या मजकूर म्हणून लिहा किंवा फोटो पाठवा*\n💡 *Please describe your issue as text or send a photo*\n\n🏛️ *PCMC सेवा*`;
    
    await sendText(phoneNumber, response);

  } catch (error) {
    logger.critical('💥 Error handling video message', {
      error: error.message,
      phoneNumber: phoneNumber.replace(/^91/, 'XXX-XXX-'),
      requestId,
      timestamp: new Date().toISOString()
    });
  }
}

/*
 * Handle sticker messages
 */
async function handleStickerMessage(messageData, phoneNumber, displayName, requestId) {
  try {
    logger.debug('😀 Sticker message received', {
      phoneNumber: phoneNumber.replace(/^91/, 'XXX-XXX-'),
      requestId,
      timestamp: new Date().toISOString()
    });

    // Save sticker message
    await saveChatMessage(phoneNumber, {
      messageId: messageData.id,
      sender: phoneNumber,
      senderName: displayName,
      receiver: 'pcmc_bot',
      messageType: 'sticker',
      content: 'Sticker sent',
      stickerMetadata: {
        mediaId: messageData.sticker.id,
        animated: messageData.sticker.animated || false
      },
      intent: 'casual_interaction',
      context: 'sticker_chat',
      conversationState: 'casual',
      language: 'auto',
      ethicalScore: 9,
      botModeEnabled: true,
      requestId
    });

    const response = `😊 *स्टिकर मिळाला!* | *Sticker received!*\n\n🏛️ *PCMC ची मदत कशी करू शकते?*\n🏛️ *How can PCMC help you?*\n\n💡 तुमची समस्या लिहा | Type your issue\n\n🏛️ *PCMC सेवा*`;
    
    await sendText(phoneNumber, response);

  } catch (error) {
    logger.critical('💥 Error handling sticker message', {
      error: error.message,
      phoneNumber: phoneNumber.replace(/^91/, 'XXX-XXX-'),
      requestId,
      timestamp: new Date().toISOString()
    });
  }
}

/*
 * Handle contact messages
 */
async function handleContactMessage(messageData, phoneNumber, displayName, requestId) {
  try {
    const contacts = messageData.contacts;
    
    logger.debug('👥 Contact message received', {
      phoneNumber: phoneNumber.replace(/^91/, 'XXX-XXX-'),
      contactCount: contacts.length,
      requestId,
      timestamp: new Date().toISOString()
    });

    // Save contacts message
    await saveChatMessage(phoneNumber, {
      messageId: messageData.id,
      sender: phoneNumber,
      senderName: displayName,
      receiver: 'pcmc_bot',
      messageType: 'contacts',
      content: `${contacts.length} contact(s) shared`,
      contactsMetadata: {
        contactCount: contacts.length,
        contacts: contacts.map(contact => ({
          name: contact.name?.formatted_name || 'Unknown',
          phone: contact.phones?.[0]?.phone || null
        }))
      },
      intent: 'contact_sharing',
      context: 'information_sharing',
      conversationState: 'contacts_received',
      language: 'auto',
      ethicalScore: 8,
      botModeEnabled: true,
      requestId
    });

    const response = `👥 *संपर्क प्राप्त झाले* | *Contacts Received*\n\n📞 ${contacts.length} संपर्क मिळाले\n📞 ${contacts.length} contact(s) received\n\nधन्यवाद! आम्हाला संपर्क मिळाले.\nThank you! We received the contacts.\n\n🏛️ *PCMC ची मदत कशी करू शकते?*\n🏛️ *How can PCMC help you?*\n\n🏛️ *PCMC सेवा*`;
    
    await sendText(phoneNumber, response);

  } catch (error) {
    logger.critical('💥 Error handling contact message', {
      error: error.message,
      phoneNumber: phoneNumber.replace(/^91/, 'XXX-XXX-'),
      requestId,
      timestamp: new Date().toISOString()
    });
  }
}

/*
 * Send unsupported message type response
 */
async function sendUnsupportedMessageResponse(phoneNumber, messageType) {
  try {
    const response = `❓ *असमर्थित संदेश प्रकार* | *Unsupported Message Type*\n\n📱 *प्रकार:* ${messageType}\n📱 *Type:* ${messageType}\n\nकृपया मजकूर संदेश, फोटो, किंवा ऑडिओ पाठवा.\nPlease send text message, photo, or audio.\n\n💡 *समर्थित प्रकार | Supported types:*\n• 📝 मजकूर | Text\n• 🖼️ फोटो | Photo\n• 🎙️ ऑडिओ | Audio\n• 📍 स्थान | Location\n\n🏛️ *PCMC सेवा*`;
    
    await sendText(phoneNumber, response);
  } catch (error) {
    logger.warning('⚠️ Error sending unsupported message response', {
      error: error.message,
      messageType,
      timestamp: new Date().toISOString()
    });
  }
}

/*
 * Handle general conversation flow
 */

async function handleGeneralConversation(messageText, phoneNumber, displayName, intentAnalysis, language, requestId) {
  try {
    logger.ai('💬 Processing general conversation', {
      phoneNumber: phoneNumber.replace(/^91/, 'XXX-XXX-'),
      intent: intentAnalysis.intent,
      language,
      requestId,
      timestamp: new Date().toISOString()
    });
    
    // Get conversation context
    const conversationContext = await getConversationContext(phoneNumber, 5);
    
    // Process with AI
    const aiResponse = await processMessageWithAI(
      messageText, 
      phoneNumber, 
      intentAnalysis, 
      conversationContext,
      language
    );

    await sendText(phoneNumber, aiResponse.message);

    // Save bot response
    await saveChatMessage(phoneNumber, {
      messageId: generateTicketId(8),
      sender: 'pcmc_bot',
      senderName: 'PCMC Assistant',
      receiver: phoneNumber,
      messageType: 'text',
      content: aiResponse.message,
      intent: 'response',
      context: intentAnalysis.context,
      conversationState: 'completed',
      language,
      ethicalScore: 10,
      botModeEnabled: true,
      aiMetadata: {
        originalIntent: intentAnalysis.intent,
        processingTime: Date.now() - Date.now(),
        knowledgeBaseUsed: true,
        responseType: 'general_conversation'
      },
      requestId
    });

    logger.success('✅ General conversation completed successfully', { 
      requestId,
      timestamp: new Date().toISOString()
    });

  } catch (error) {
    logger.critical('💥 Error in general conversation', { 
      error: error.message,
      stack: error.stack,
      phoneNumber: phoneNumber.replace(/^91/, 'XXX-XXX-'),
      requestId,
      timestamp: new Date().toISOString()
    });
    
    const errorMessage = language === 'marathi' ? 
      '😔 माफ करा, मी सध्या मदत करू शकत नाही. कृपया पुन्हा प्रयत्न करा.\n\n📞 तातडीच्या मदतीसाठी: 020-27475000\n\n🏛️ *PCMC सेवा*' :
      '😔 Sorry, I cannot help right now. Please try again.\n\n📞 For urgent help: 020-27475000\n\n🏛️ *PCMC Service*';
    await sendText(phoneNumber, errorMessage);
  }
}

/*
 * Handle query flow
 */
async function handleQueryFlow(messageText, phoneNumber, displayName, intentAnalysis, language, requestId) {
  try {
    logger.ai('❓ Processing information query', { 
      requestId,
      timestamp: new Date().toISOString()
    });
    
    const conversationContext = await getConversationContext(phoneNumber, 3);
    const aiResponse = await processMessageWithAI(
      messageText, 
      phoneNumber, 
      intentAnalysis, 
      conversationContext,
      language
    );

    await sendText(phoneNumber, aiResponse.message);

    await saveChatMessage(phoneNumber, {
      messageId: generateTicketId(8),
      sender: 'pcmc_bot',
      senderName: 'PCMC Assistant',
      receiver: phoneNumber,
      messageType: 'text',
      content: aiResponse.message,
      intent: 'query_response',
      context: intentAnalysis.context,
      conversationState: 'query_completed',
      language,
      ethicalScore: 10,
      botModeEnabled: true,
      aiMetadata: {
        queryType: intentAnalysis.context,
        knowledgeBaseUsed: true,
        responseType: 'informational'
      },
      requestId
    });

    logger.success('✅ Query processed successfully', { 
      requestId,
      timestamp: new Date().toISOString()
    });

  } catch (error) {
    logger.critical('💥 Error in query flow', { 
      error: error.message,
      phoneNumber: phoneNumber.replace(/^91/, 'XXX-XXX-'),
      requestId,
      timestamp: new Date().toISOString()
    });
    
    const errorMessage = language === 'marathi' ? 
      '😔 माहिती मिळविताना समस्या आली. कृपया पुन्हा प्रयत्न करा.\n\n📞 मदतीसाठी: 020-27475000' :
      '😔 Error retrieving information. Please try again.\n\n📞 For help: 020-27475000';
    await sendText(phoneNumber, errorMessage);
  }
}

/*
 * Handle greeting flow
 */
async function handleGreetingFlow(messageText, phoneNumber, displayName, intentAnalysis, language, requestId) {
  try {
    logger.ai('👋 Processing greeting', { 
      requestId,
      timestamp: new Date().toISOString()
    });
    
    const greeting = language === 'marathi' ? 
      `🙏 *नमस्कार ${displayName}!*\n\n🏛️ *पिंपरी-चिंचवड महानगरपालिकेत (PCMC) आपले स्वागत आहे!*\n\nमी आपला AI सहायक आहे. मी आपली मदत करू शकतो:\n\n💧 *पाणीपुरवठा समस्या*\n🗑️ *कचरा व्यवस्थापन*\n🛣️ *रस्ते आणि दिवे*\n🏥 *आरोग्य सेवा*\n🏗️ *इमारत परवानगी*\n💰 *मालमत्ता कर*\n📋 *तक्रार स्थिती तपासा*\n\n💡 *कसे सुरुवात करावी:*\n• तुमची समस्या लिहा\n• "माझ्या तक्रारी" टाइप करा\n• फोटो पाठवा\n\n🏛️ *PCMC सेवा*` :
      `👋 *Hello ${displayName}!*\n\n🏛️ *Welcome to Pimpri-Chinchwad Municipal Corporation (PCMC)!*\n\nI'm your AI assistant. I can help you with:\n\n💧 *Water Supply Issues*\n🗑️ *Waste Management*\n🛣️ *Roads & Street Lights*\n🏥 *Health Services*\n🏗️ *Building Permissions*\n💰 *Property Tax*\n📋 *Check Complaint Status*\n\n💡 *How to start:*\n• Describe your problem\n• Type "my complaints"\n• Send a photo\n\n🏛️ *PCMC Service*`;

    await sendText(phoneNumber, greeting);

    await saveChatMessage(phoneNumber, {
      messageId: generateTicketId(8),
      sender: 'pcmc_bot',
      senderName: 'PCMC Assistant',
      receiver: phoneNumber,
      messageType: 'text',
      content: greeting,
      intent: 'greeting_response',
      context: 'welcome',
      conversationState: 'welcomed',
      language,
      ethicalScore: 10,
      botModeEnabled: true,
      aiMetadata: {
        responseType: 'welcome_message',
        isNewConversation: true
      },
      requestId
    });

    logger.success('✅ Greeting processed successfully', { 
      requestId,
      timestamp: new Date().toISOString()
    });

  } catch (error) {
    logger.critical('💥 Error in greeting flow', { 
      error: error.message,
      phoneNumber: phoneNumber.replace(/^91/, 'XXX-XXX-'),
      requestId,
      timestamp: new Date().toISOString()
    });
  }
}

/*
 * Handle small talk flow
 */
async function handleSmallTalkFlow(messageText, phoneNumber, displayName, intentAnalysis, language, requestId) {
  try {
    logger.ai('💬 Processing small talk', { 
      requestId,
      timestamp: new Date().toISOString()
    });
    
    const smallTalkResponse = language === 'marathi' ? 
      `😊 *धन्यवाद!*\n\nमी PCMC AI सहायक आहे. मी तुम्हाला महानगरपालिकेच्या सेवांमध्ये मदत करू शकतो.\n\n🏛️ *PCMC ची सेवा कशी करू शकते?*\n\n💡 *तुमची समस्या किंवा प्रश्न सांगा:*\n• पाणीपुरवठा\n• कचरा संकलन\n• रस्ता दुरुस्ती\n• तक्रार स्थिती\n• इतर सेवा\n\n🏛️ *PCMC सेवा*` :
      `😊 *Thank you!*\n\nI'm the PCMC AI assistant. I can help you with municipal services.\n\n🏛️ *How can PCMC assist you?*\n\n💡 *Tell me your issue or question:*\n• Water supply\n• Waste collection\n• Road repairs\n• Complaint status\n• Other services\n\n🏛️ *PCMC Service*`;

    await sendText(phoneNumber, smallTalkResponse);

    await saveChatMessage(phoneNumber, {
      messageId: generateTicketId(8),
      sender: 'pcmc_bot',
      senderName: 'PCMC Assistant',
      receiver: phoneNumber,
      messageType: 'text',
      content: smallTalkResponse,
      intent: 'small_talk_response',
      context: 'casual_redirect',
      conversationState: 'redirected_to_service',
      language,
      ethicalScore: 10,
      botModeEnabled: true,
      aiMetadata: {
        responseType: 'casual_redirect',
        redirectedToService: true
      },
      requestId
    });

    logger.success('✅ Small talk processed successfully', { 
      requestId,
      timestamp: new Date().toISOString()
    });

  } catch (error) {
    logger.critical('💥 Error in small talk flow', { 
      error: error.message,
      phoneNumber: phoneNumber.replace(/^91/, 'XXX-XXX-'),
      requestId,
      timestamp: new Date().toISOString()
    });
  }
}

/*
 * Process message status updates (read, delivered, sent, etc.)
 */
async function processMessageStatus(body, requestId) {
  try {
    const status = body.entry[0].changes[0].value.statuses[0];
    const messageId = status.id;
    const statusType = status.status;
    const recipientId = status.recipient_id;
    
    logger.webhook('📊 Message status update', {
      messageId,
      status: statusType,
      recipient: recipientId.replace(/^91/, 'XXX-XXX-'),
      timestamp: status.timestamp,
      requestId
    });

    // Log different status types
    switch (statusType) {
      case 'sent':
        logger.debug(`📤 Message sent: ${messageId}`);
        break;
      case 'delivered':
        logger.debug(`📬 Message delivered: ${messageId}`);
        break;
      case 'read':
        logger.debug(`👁️ Message read: ${messageId}`);
        break;
      case 'failed':
        logger.warning(`❌ Message failed: ${messageId}`, {
          error: status.errors?.[0] || 'Unknown error'
        });
        break;
      default:
        logger.debug(`📊 Status update: ${statusType} for ${messageId}`);
    }

    // Optionally update message status in database
    await updateMessageStatus(messageId, statusType, recipientId);

  } catch (error) {
    logger.warning('⚠️ Error processing message status', {
      error: error.message,
      requestId,
      body: JSON.stringify(body).substring(0, 200),
      timestamp: new Date().toISOString()
    });
  }
}

/*
 * Update message status in database
 */
async function updateMessageStatus(messageId, status, recipientId) {
  try {
    // This is optional - you can track message delivery status
    const statusUpdate = {
      messageId,
      status,
      recipientId,
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      statusUpdatedAt: new Date().toISOString()
    };

    // You could store this in a message_status collection if needed
    logger.debug('📊 Message status would be updated', statusUpdate);

  } catch (error) {
    logger.warning('⚠️ Error updating message status', { 
      error: error.message,
      timestamp: new Date().toISOString()
    });
  }
}

/*
 * Rate limiting implementation
 */
async function isRateLimited(phoneNumber) {
  try {
    const now = Date.now();
    const userKey = phoneNumber;
    
    if (!rateLimitStore.has(userKey)) {
      rateLimitStore.set(userKey, { count: 1, resetTime: now + RATE_LIMIT_WINDOW });
      return false;
    }

    const userData = rateLimitStore.get(userKey);
    
    if (now > userData.resetTime) {
      // Reset the counter
      rateLimitStore.set(userKey, { count: 1, resetTime: now + RATE_LIMIT_WINDOW });
      return false;
    }

    if (userData.count >= RATE_LIMIT_MAX_MESSAGES) {
      logger.warning('🚫 Rate limit exceeded', {
        phoneNumber: phoneNumber.replace(/^91/, 'XXX-XXX-'),
        count: userData.count,
        resetTime: new Date(userData.resetTime).toISOString(),
        timestamp: new Date().toISOString()
      });
      return true;
    }

    userData.count++;
    rateLimitStore.set(userKey, userData);
    return false;

  } catch (error) {
    logger.warning('⚠️ Error checking rate limit', { 
      error: error.message,
      timestamp: new Date().toISOString()
    });
    return false; // Allow on error
  }
}

/*
 * Handle rate limit exceeded
 */
async function handleRateLimit(phoneNumber, messageType) {
  try {
    const rateLimitMessage = `🚫 *दर मर्यादा ओलांडली* | *Rate Limit Exceeded*\n\n⏳ *कृपया 1 मिनिट प्रतीक्षा करा*\n⏳ *Please wait 1 minute*\n\nतुम्ही खूप जलद संदेश पाठवत आहात.\nYou're sending messages too quickly.\n\n💡 *तातडीच्या मदतीसाठी:* 020-27475000\n💡 *For urgent help:* 020-27475000\n\n🏛️ *PCMC सेवा*`;
    
    await sendText(phoneNumber, rateLimitMessage);

    logger.warning('🚫 Rate limit message sent', {
      phoneNumber: phoneNumber.replace(/^91/, 'XXX-XXX-'),
      messageType,
      timestamp: new Date().toISOString()
    });

  } catch (error) {
    logger.critical('💥 Error handling rate limit', {
      error: error.message,
      phoneNumber: phoneNumber.replace(/^91/, 'XXX-XXX-'),
      timestamp: new Date().toISOString()
    });
  }
}

/*
 * Send emergency error message when processing fails
 */
async function sendEmergencyErrorMessage(phoneNumber) {
  try {
    const emergencyMessage = `🚨 *तांत्रिक समस्या* | *Technical Issue*\n\n😔 आत्ता मी मदत करू शकत नाही.\n😔 I cannot help right now.\n\n📞 *तातडीच्या मदतीसाठी:*\n📞 *For urgent help:*\n020-27475000\n\n🕐 *कार्यालयीन वेळ:* सकाळी 10 ते संध्याकाळी 5:30\n🕐 *Office Hours:* 10 AM to 5:30 PM\n\n🏛️ *PCMC सेवा*`;
    
    await sendText(phoneNumber, emergencyMessage);

  } catch (error) {
    logger.critical('💥 Failed to send emergency error message', {
      error: error.message,
      phoneNumber: phoneNumber.replace(/^91/, 'XXX-XXX-'),
      timestamp: new Date().toISOString()
    });
  }
}

/*
 * Get pending complaint for user (waiting for location)
 */
async function getPendingComplaintForUser(phoneNumber) {
  try {
    const complaintsRef = admin.firestore().collection('complaints');
    const snapshot = await complaintsRef
      .where('createdBy', '==', phoneNumber)
      .where('status', '==', 'draft')
      .where('requiresLocationSharing', '==', true)
      .orderBy('createdAt', 'desc')
      .limit(1)
      .get();

    if (snapshot.empty) {
      return null;
    }

    const complaintDoc = snapshot.docs[0];
    return { id: complaintDoc.id, ...complaintDoc.data() };

  } catch (error) {
    logger.warning('⚠️ Error getting pending complaint', {
      error: error.message,
      phoneNumber: phoneNumber.replace(/^91/, 'XXX-XXX-'),
      timestamp: new Date().toISOString()
    });
    return null;
  }
}

/*
 * Download audio file from WhatsApp
 */
async function downloadAudioFile(mediaUrl, mediaId) {
  try {
    const tempDir = path.join(process.cwd(), 'temp');
    if (!fs.existsSync(tempDir)) {
      fs.mkdirSync(tempDir, { recursive: true });
    }
    
    const fileName = `${mediaId}.ogg`;
    const localPath = path.join(tempDir, fileName);

    const response = await axios.get(mediaUrl, {
      responseType: 'arraybuffer',
      headers: { Authorization: `Bearer ${process.env.WHATSAPP_TOKEN}` },
      timeout: 30000
    });
    
    fs.writeFileSync(localPath, Buffer.from(response.data));
    
    logger.debug('🎙️ Audio file downloaded', {
      mediaId,
      localPath,
      fileSize: `${(response.data.byteLength / 1024).toFixed(2)} KB`,
      timestamp: new Date().toISOString()
    });
    
    return localPath;
  } catch (error) {
    logger.critical('💥 Error downloading audio file', {
      error: error.message,
      mediaId,
      mediaUrl: mediaUrl.substring(0, 50) + '...',
      timestamp: new Date().toISOString()
    });
    throw error;
  }
}

/*
 * Log message preview for debugging
 */
function logMessagePreview(messageData, messageType) {
  let preview = '';
  
  switch (messageType) {
    case 'text':
      preview = messageData.text.body.substring(0, 100);
      break;
    case 'image':
      preview = messageData.image.caption || 'Image (no caption)';
      break;
    case 'audio':
      preview = 'Audio message';
      break;
    case 'video':
      preview = messageData.video.caption || 'Video (no caption)';
      break;
    case 'document':
      preview = messageData.document.filename || 'Document';
      break;
    case 'location':
      preview = `Location: ${messageData.location.latitude}, ${messageData.location.longitude}`;
      break;
    case 'interactive':
      if (messageData.interactive.type === 'button_reply') {
        preview = `Button: ${messageData.interactive.button_reply.title}`;
      } else if (messageData.interactive.type === 'list_reply') {
        preview = `List: ${messageData.interactive.list_reply.title}`;
      } else {
        preview = `Interactive: ${messageData.interactive.type}`;
      }
      break;
    case 'sticker':
      preview = 'Sticker';
      break;
    case 'contacts':
      preview = `${messageData.contacts.length} contact(s)`;
      break;
    default:
      preview = `Unknown type: ${messageType}`;
  }
  
  logger.debug('📝 Message preview', {
    type: messageType,
    preview: preview.substring(0, 150) + (preview.length > 150 ? '...' : ''),
    messageId: messageData.id,
    timestamp: new Date().toISOString()
  });
}

/*
 * Handle list selection from interactive messages
 */
async function handleListSelection(listId, listTitle, phoneNumber, displayName, requestId) {
  try {
    logger.webhook('📋 List selection received', {
      listId,
      listTitle,
      phoneNumber: phoneNumber.replace(/^91/, 'XXX-XXX-'),
      requestId,
      timestamp: new Date().toISOString()
    });

    // Save list interaction
    await saveChatMessage(phoneNumber, {
      messageId: generateTicketId(8),
      sender: phoneNumber,
      senderName: displayName,
      receiver: 'pcmc_bot',
      messageType: 'interactive',
      content: `List selected: ${listTitle}`,
      interactiveData: { 
        type: 'list_reply',
        listId, 
        listTitle 
      },
      intent: 'list_selection',
      context: 'interactive_response',
      conversationState: 'list_selected',
      language: 'auto',
      ethicalScore: 9,
      botModeEnabled: true,
      requestId
    });

    // Handle specific list selections
    const response = `✅ *यादी निवडली* | *List Selected*\n\n"${listTitle}"\n\nतुमची निवड नोंदवली आहे.\nYour selection has been recorded.\n\n🏛️ *PCMC सेवा*`;
    
    await sendText(phoneNumber, response);

  } catch (error) {
    logger.critical('💥 Error handling list selection', {
      error: error.message,
      phoneNumber: phoneNumber.replace(/^91/, 'XXX-XXX-'),
      requestId,
      timestamp: new Date().toISOString()
    });
  }
}

/*
 * Utility functions for formatting status display
 */
function getStatusEmoji(status) {
  const statusEmojis = {
    'draft': '📝',
    'active': '🔄',
    'open': '🔓',
    'in_progress': '⚙️',
    'resolved': '✅',
    'closed': '🔒',
    'cancelled': '❌',
    'pending': '⏳'
  };
  return statusEmojis[status] || '❓';
}

function getPriorityEmoji(priority) {
  const priorityEmojis = {
    'emergency': '🚨',
    'high': '🔴',
    'medium': '🟡',
    'low': '🟢'
  };
  return priorityEmojis[priority] || '⚪';
}

function getProgressBar(percentage) {
  const filled = Math.floor(percentage / 10);
  const empty = 10 - filled;
  return '🟩'.repeat(filled) + '⬜'.repeat(empty);
}

function formatDate(timestamp) {
  try {
    let date;
    if (timestamp && typeof timestamp.toDate === 'function') {
      date = timestamp.toDate();
    } else if (timestamp instanceof Date) {
      date = timestamp;
    } else if (typeof timestamp === 'string') {
      date = new Date(timestamp);
    } else {
      return 'Unknown date';
    }
    
    return date.toLocaleDateString('en-IN', {
      year: 'numeric',
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
      timeZone: 'Asia/Kolkata'
    });
  } catch (error) {
    return 'Invalid date';
  }
}

/*
 * Clean up old rate limit entries (periodic cleanup)
 */
function cleanupRateLimit() {
  const now = Date.now();
  let cleanedCount = 0;
  
  for (const [key, data] of rateLimitStore.entries()) {
    if (now > data.resetTime) {
      rateLimitStore.delete(key);
      cleanedCount++;
    }
  }
  
  if (cleanedCount > 0) {
    logger.debug(`🧹 Rate limit cleanup: removed ${cleanedCount} expired entries`);
  }
}

// Run cleanup every 5 minutes
setInterval(cleanupRateLimit, 5 * 60 * 1000);

/*
 * Get webhook statistics
 */
function getWebhookStats() {
  return {
    version: WEBHOOK_VERSION,
    lastUpdated: WEBHOOK_UPDATED,
    updatedBy: UPDATED_BY,
    uptime: process.uptime(),
    rateLimitEntries: rateLimitStore.size,
    memoryUsage: process.memoryUsage(),
    timestamp: new Date().toISOString(),
    environment: process.env.NODE_ENV || 'development',
    features: {
      complaintStatusQuery: true,
      duplicateDetection: true,
      aiProcessing: true,
      multiLanguageSupport: true,
      rateLimit: true,
      audioTranscription: true,
      imageAnalysis: true,
      locationHandling: true
    },
    performance: {
      maxProcessingTime: MAX_PROCESSING_TIME,
      rateLimitWindow: RATE_LIMIT_WINDOW,
      rateLimitMaxMessages: RATE_LIMIT_MAX_MESSAGES
    }
  };
}

/*
 * Health check endpoint for webhook
 */
async function healthCheck() {
  try {
    const stats = getWebhookStats();
    
    // Test essential services
    const firebaseHealthStart = Date.now();
    const firebaseHealth = await admin.firestore().collection('_health').doc('test').get();
    const firebaseResponseTime = Date.now() - firebaseHealthStart;
    
    const whatsappHealth = process.env.WHATSAPP_TOKEN ? 'configured' : 'missing';
    const openaiHealth = process.env.OPENAI_API_KEY ? 'configured' : 'missing';
    const googleMapsHealth = process.env.GOOGLE_MAPS_API_KEY ? 'configured' : 'missing';
    
    return {
      status: 'healthy',
      webhook: stats,
      services: {
        firebase: {
          status: firebaseHealth.exists ? 'operational' : 'error',
          responseTime: firebaseResponseTime
        },
        whatsapp: whatsappHealth,
        openai: openaiHealth,
        googleMaps: googleMapsHealth,
        rateLimiting: 'operational'
      },
      configuration: {
        maxProcessingTime: MAX_PROCESSING_TIME,
        rateLimitWindow: RATE_LIMIT_WINDOW,
        rateLimitMaxMessages: RATE_LIMIT_MAX_MESSAGES,
        supportedLanguages: ['english', 'marathi'],
        supportedMessageTypes: ['text', 'audio', 'image', 'location', 'interactive', 'document', 'video', 'sticker', 'contacts']
      },
      timestamp: new Date().toISOString(),
      deployedBy: UPDATED_BY,
      lastDeployment: WEBHOOK_UPDATED
    };
  } catch (error) {
    return {
      status: 'unhealthy',
      error: error.message,
      stack: error.stack,
      timestamp: new Date().toISOString(),
      version: WEBHOOK_VERSION
    };
  }
}

/*
 * Graceful shutdown handler
 */
function setupGracefulShutdown() {
  const gracefulShutdown = (signal) => {
    logger.info(`🛑 Received ${signal}. Starting graceful shutdown...`);
    
    // Clear rate limit store
    rateLimitStore.clear();
    
    // Log final statistics
    const finalStats = getWebhookStats();
    logger.info('📊 Final webhook statistics', finalStats);
    
    process.exit(0);
  };

  process.on('SIGINT', () => gracefulShutdown('SIGINT'));
  process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
}

// Initialize graceful shutdown
setupGracefulShutdown();

/*
 * Webhook initialization
 */
function initializeWebhook() {
  logger.info('🚀 Webhook controller initialized', {
    version: WEBHOOK_VERSION,
    timestamp: new Date().toISOString(),
    updatedBy: UPDATED_BY,
    lastUpdated: WEBHOOK_UPDATED,
    features: {
      complaintStatusQuery: '✅ Enabled',
      duplicateDetection: '✅ Enabled', 
      aiProcessing: '✅ Enabled',
      rateLimit: '✅ Enabled',
      audioTranscription: '✅ Enabled',
      imageAnalysis: '✅ Enabled',
      locationHandling: '✅ Enabled',
      multiLanguage: '✅ Enabled (English/Marathi)'
    }
  });
}

// Initialize on module load
initializeWebhook();

// Export the main handler and utility functions
module.exports = {
  handleWebhook,
  healthCheck,
  getWebhookStats,
  
  // Export individual handlers for testing
  processIncomingMessage,
  handleTextMessage,
  handleAudioMessage,
  handleImageMessage,
  handleLocationMessage,
  handleInteractiveMessage,
  handleComplaintStatusQuery,
  handleComplaintFlow,
  sendComplaintConfirmation,
  
  // Flow handlers
  handleGeneralConversation,
  handleQueryFlow,
  handleGreetingFlow,
  handleSmallTalkFlow,
  
  // Interactive handlers
  handleComplaintConfirmation,
  handleComplaintCancellation,
  handleListSelection,
  
  // Message type handlers
  handleDocumentMessage,
  handleVideoMessage,
  handleStickerMessage,
  handleContactMessage,
  
  // Utility functions
  isRateLimited,
  handleRateLimit,
  getPendingComplaintForUser,
  downloadAudioFile,
  formatComplaintStatusMessage,
  getStatusEmoji,
  getPriorityEmoji,
  getProgressBar,
  formatDate,
  logMessagePreview,
  sendUnsupportedMessageResponse,
  sendEmergencyErrorMessage,
  
  // Configuration constants
  WEBHOOK_VERSION,
  WEBHOOK_UPDATED,
  UPDATED_BY,
  MAX_PROCESSING_TIME,
  RATE_LIMIT_WINDOW,
  RATE_LIMIT_MAX_MESSAGES
};