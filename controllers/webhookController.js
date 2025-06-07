// controllers/webhookController.js
const admin = require('firebase-admin');
const fs = require('fs');
const path = require('path');

// Firebase Service Imports
const {
  ensureCitizenExists,
  getCitizenBotMode,
  saveChatMessage,
  updateCitizenEthicalScore,
  checkDuplicateComplaint,
  createDraftComplaint,
  confirmComplaint,
  cancelComplaint,
  getConversationContext,
  getMediaUrl,
  downloadAndUploadImage,
  geocodeAddress,
  sanitizeFirestoreData
} = require('../services/firebaseService');

// WhatsApp Service Imports
const {
  sendTextMessage,
  sendQuickReply,
  sendLocationRequest,
  sendListMessage,
  markMessageAsRead,
} = require('../services/whatsappService');

// AI Service Imports
const {
  processMessageWithAI,
  analyzeIntent,
  calculateEthicalScore,
  transcribeAudio,
  analyzeImageContent,
  detectLanguage
} = require('../services/aiService');

// Utility Imports
const { generateTicketId, sanitizeInput, formatPhoneNumber } = require('../utils/helpers');
const { downloadAudioFile } = require('../utils/mediaHandlers');
const logger = require('../utils/logger');

/**
 * Main webhook handler for WhatsApp Cloud API
 */
async function handleWebhook(req, res) {
  const startTime = Date.now();
  logger.webhook('📥 Webhook request received', {
    method: req.method,
    contentType: req.get('Content-Type'),
    bodySize: JSON.stringify(req.body).length,
    userAgent: req.get('User-Agent'),
    ip: req.ip,
    timestamp: new Date().toISOString()
  });

  try {
    const body = req.body;
    
    // Validate webhook payload structure
    if (!body || typeof body !== 'object') {
      logger.warning('❌ Invalid webhook payload - not an object', { body });
      return res.sendStatus(400);
    }
    
    // Validate webhook object type
    if (!body.object || body.object !== 'whatsapp_business_account') {
      logger.warning('❌ Invalid webhook object received', { 
        object: body.object,
        expectedObject: 'whatsapp_business_account',
        receivedKeys: Object.keys(body)
      });
      return res.sendStatus(404);
    }

    logger.webhook('✅ Valid WhatsApp webhook payload received');

    // Handle incoming messages
    if (body.entry?.[0]?.changes?.[0]?.value?.messages) {
      logger.webhook('📨 Processing incoming message');
      await processIncomingMessage(body);
      const processingTime = Date.now() - startTime;
      logger.webhook(`✅ Message processed successfully in ${processingTime}ms`);
      return res.sendStatus(200);
    }

    // Handle message status updates
    if (body.entry?.[0]?.changes?.[0]?.value?.statuses) {
      logger.webhook('📊 Processing message status update');
      await processMessageStatus(body);
      logger.webhook('✅ Status update processed');
      return res.sendStatus(200);
    }

    // Handle other webhook events
    if (body.entry?.[0]?.changes?.[0]?.field) {
      const field = body.entry[0].changes[0].field;
      logger.webhook(`ℹ️ Webhook event for field: ${field}`, { field });
      return res.sendStatus(200);
    }

    // Default response for unhandled webhooks
    logger.webhook('ℹ️ Unhandled webhook payload received', { 
      hasEntry: !!body.entry,
      hasChanges: !!body.entry?.[0]?.changes,
      hasValue: !!body.entry?.[0]?.changes?.[0]?.value,
      bodyStructure: Object.keys(body)
    });
    res.sendStatus(200);

  } catch (error) {
    const processingTime = Date.now() - startTime;
    logger.critical('💥 Error in webhook handler', {
      error: error.message,
      stack: error.stack,
      processingTime,
      bodyKeys: Object.keys(req.body || {}),
      url: req.url,
      method: req.method
    });
    res.sendStatus(500);
  }
}

/**
 * Process incoming messages based on type
 */
async function processIncomingMessage(body) {
  const messageStartTime = Date.now();
  
  try {
    const messageData = body.entry[0].changes[0].value;
    const message = messageData.messages[0];
    const contact = messageData.contacts?.[0];
    const metadata = messageData.metadata;

    const phoneNumber = formatPhoneNumber(message.from);
    const displayName = contact?.profile?.name || 'Unknown User';
    const messageType = message.type;
    const messageId = message.id;
    const timestamp = message.timestamp;

    logger.citizen('👤 New message from citizen', {
      phoneNumber: phoneNumber.replace(/^91/, 'XXX-XXX-'),
      displayName,
      messageType,
      messageId,
      timestamp: new Date(parseInt(timestamp) * 1000).toISOString()
    });

    // Log message content preview based on type
    let contentPreview = '';
    switch (messageType) {
      case 'text':
        contentPreview = message.text?.body?.substring(0, 100) + '...';
        logger.debug('📝 Text message content', {
          contentPreview,
          contentLength: message.text?.body?.length || 0
        });
        break;
      case 'audio':
        logger.debug('🎵 Audio message received', {
          mediaId: message.audio?.id,
          mimeType: message.audio?.mime_type
        });
        break;
      case 'image':
        logger.debug('🖼️ Image message received', {
          mediaId: message.image?.id,
          caption: message.image?.caption || 'No caption'
        });
        break;
      case 'location':
        logger.debug('📍 Location message received', {
          latitude: message.location?.latitude,
          longitude: message.location?.longitude,
          name: message.location?.name
        });
        break;
      case 'interactive':
        logger.debug('🔘 Interactive message received', {
          type: message.interactive?.type,
          buttonId: message.interactive?.button_reply?.id
        });
        break;
      default:
        logger.debug(`📄 ${messageType} message received`);
    }

    // Ensure citizen exists in database
    logger.firebase('Ensuring citizen exists in database...');
    await ensureCitizenExists(phoneNumber, displayName);

    // Mark message as read
    logger.whatsapp('Marking message as read...');
    await markMessageAsRead(messageId);

    // Route to appropriate handler based on message type
    logger.debug(`🔄 Routing to ${messageType} message handler`);
    
    switch (messageType) {
      case 'text':
        await handleTextMessage(message, phoneNumber, displayName, messageId);
        break;
      case 'audio':
        await handleAudioMessage(message, phoneNumber, displayName, messageId);
        break;
      case 'image':
        await handleImageMessage(message, phoneNumber, displayName, messageId);
        break;
      case 'location':
        await handleLocationMessage(message, phoneNumber, displayName, messageId);
        break;
      case 'interactive':
        await handleInteractiveMessage(message, phoneNumber, displayName, messageId);
        break;
      case 'document':
        await handleDocumentMessage(message, phoneNumber, displayName, messageId);
        break;
      case 'video':
        await handleVideoMessage(message, phoneNumber, displayName, messageId);
        break;
      case 'sticker':
        await handleStickerMessage(message, phoneNumber, displayName, messageId);
        break;
      case 'contacts':
        await handleContactMessage(message, phoneNumber, displayName, messageId);
        break;
      default:
        logger.warning(`❓ Unsupported message type: ${messageType}`);
        await sendUnsupportedMessageResponse(phoneNumber, messageType);
    }

    const processingTime = Date.now() - messageStartTime;
    logger.success(`Message processing completed in ${processingTime}ms`, {
      phoneNumber: phoneNumber.replace(/^91/, 'XXX-XXX-'),
      messageType,
      processingTime
    });

  } catch (error) {
    const processingTime = Date.now() - messageStartTime;
    logger.critical('💥 Error processing incoming message', {
      error: error.message,
      stack: error.stack,
      processingTime,
      messageData: body.entry?.[0]?.changes?.[0]?.value?.messages?.[0]?.type || 'unknown'
    });
    
    // Try to send error message to user if we have phone number
    try {
      const phoneNumber = formatPhoneNumber(body.entry[0].changes[0].value.messages[0].from);
      await sendTextMessage(phoneNumber, 
        'माफ करा, तांत्रिक समस्या आली आहे. कृपया थोड्या वेळाने पुन्हा प्रयत्न करा.\n\nSorry, there was a technical issue. Please try again in a moment.'
      );
    } catch (errorResponseError) {
      logger.critical('Failed to send error response to user', {
        error: errorResponseError.message
      });
    }
  }
}

/**
 * Handle text messages with AI processing
 */
async function handleTextMessage(message, phoneNumber, displayName, messageId) {
  const textStartTime = Date.now();
  const messageText = sanitizeInput(message.text.body);
  
  logger.ai('🤖 Processing text message', {
    phoneNumber: phoneNumber.replace(/^91/, 'XXX-XXX-'),
    textPreview: messageText.substring(0, 50) + '...',
    textLength: messageText.length,
    messageId
  });

  try {
    // Check if bot mode is enabled for this citizen
    logger.firebase('Checking citizen bot mode...');
    const botModeEnabled = await getCitizenBotMode(phoneNumber);
    logger.firebase(`Bot mode status: ${botModeEnabled ? 'enabled' : 'disabled'}`);
    
    // Analyze message intent and context
    logger.ai('Analyzing message intent and context...');
    const intentAnalysis = await analyzeIntent(messageText, phoneNumber);
    logger.ai('Intent analysis completed', {
      intent: intentAnalysis.intent,
      context: intentAnalysis.context,
      state: intentAnalysis.state,
      confidence: intentAnalysis.confidence
    });
    
    // Calculate ethical score
    logger.ai('Calculating ethical score...');
    const ethicalScore = await calculateEthicalScore(messageText);
    logger.ai(`Ethical score calculated: ${ethicalScore}/10`);
    
    // Detect language
    logger.ai('Detecting language...');
    const detectedLanguage = detectLanguage(messageText);
    logger.ai(`Language detected: ${detectedLanguage}`);

    // Save message to conversation log with sanitized data
    logger.firebase('Saving message to conversation log...');
    await saveChatMessage(phoneNumber, sanitizeFirestoreData({
      messageId,
      sender: phoneNumber,
      senderName: displayName,
      receiver: 'pcmc_bot',
      messageType: 'text',
      content: messageText,
      timestamp: admin.firestore.FieldValue.serverTimestamp(),
      intent: intentAnalysis.intent,
      context: intentAnalysis.context,
      conversationState: intentAnalysis.state,
      language: detectedLanguage,
      ethicalScore,
      botModeEnabled,
      confidence: intentAnalysis.confidence
    }));

    // Update citizen's ethical score
    logger.firebase('Updating citizen ethical score...');
    await updateCitizenEthicalScore(phoneNumber, ethicalScore);

    // If bot mode is disabled, only log the message
    if (!botModeEnabled) {
      logger.warning(`🔕 Bot mode disabled for ${phoneNumber.replace(/^91/, 'XXX-XXX-')}. Message logged only.`);
      await sendTextMessage(phoneNumber, 
        'तुमचा संदेश नोंदवला आहे. सध्या AI सहाय्यक निष्क्रिय आहे.\n\nYour message has been logged. AI assistant is currently disabled.'
      );
      return;
    }

    // Process based on intent
    switch (intentAnalysis.intent) {
      case 'complaint':
        logger.complaint('🎯 Processing complaint flow...');
        await handleComplaintFlow(messageText, phoneNumber, displayName, intentAnalysis, detectedLanguage);
        break;
      case 'query':
        logger.ai('❓ Processing information query...');
        await handleQueryFlow(messageText, phoneNumber, displayName, intentAnalysis, detectedLanguage);
        break;
      case 'greeting':
        logger.ai('👋 Processing greeting...');
        await handleGreetingFlow(messageText, phoneNumber, displayName, intentAnalysis, detectedLanguage);
        break;
      case 'small_talk':
        logger.ai('💬 Processing small talk...');
        await handleSmallTalkFlow(messageText, phoneNumber, displayName, intentAnalysis, detectedLanguage);
        break;
      default:
        logger.ai('🔄 Processing general conversation...');
        await handleGeneralConversation(messageText, phoneNumber, displayName, intentAnalysis, detectedLanguage);
    }

    const processingTime = Date.now() - textStartTime;
    logger.success(`Text message processed in ${processingTime}ms`, {
      intent: intentAnalysis.intent,
      language: detectedLanguage,
      ethicalScore
    });

  } catch (error) {
    const processingTime = Date.now() - textStartTime;
    logger.critical('💥 Error in text message handling', {
      error: error.message,
      stack: error.stack,
      phoneNumber: phoneNumber.replace(/^91/, 'XXX-XXX-'),
      messageId,
      processingTime
    });
    
    // Send error response to user
    const errorMessage = detectLanguage(messageText) === 'marathi' ? 
      'माफ करा, तुमचा संदेश प्रक्रिया करताना समस्या आली. कृपया पुन्हा प्रयत्न करा.' :
      'Sorry, there was an error processing your message. Please try again.';
    
    await sendTextMessage(phoneNumber, errorMessage);
  }
}

/**
 * Handle audio messages with transcription
 */
async function handleAudioMessage(message, phoneNumber, displayName, messageId) {
  const audioStartTime = Date.now();
  
  logger.ai('🎵 Processing audio message', { 
    phoneNumber: phoneNumber.replace(/^91/, 'XXX-XXX-'),
    mediaId: message.audio.id,
    mimeType: message.audio.mime_type
  });

  let localAudioPath = null;

  try {
    const botModeEnabled = await getCitizenBotMode(phoneNumber);
    
    // Download and transcribe audio
    logger.whatsapp('Downloading audio file...');
    const mediaUrl = await getMediaUrl(message.audio.id);
    localAudioPath = await downloadAudioFile(mediaUrl, message.audio.id);
    
    logger.ai('Transcribing audio with Whisper...');
    const transcript = await transcribeAudio(localAudioPath);
    logger.ai('Audio transcription completed', { 
      transcriptPreview: transcript.substring(0, 100) + '...',
      transcriptLength: transcript.length
    });

    // Analyze transcript
    const intentAnalysis = await analyzeIntent(transcript, phoneNumber);
    const ethicalScore = await calculateEthicalScore(transcript);
    const detectedLanguage = detectLanguage(transcript);

    // Save message with transcript using sanitized data
    await saveChatMessage(phoneNumber, sanitizeFirestoreData({
      messageId,
      sender: phoneNumber,
      senderName: displayName,
      receiver: 'pcmc_bot',
      messageType: 'audio',
      content: transcript,
      audioMetadata: {
        mediaId: message.audio.id,
        mimeType: message.audio.mime_type,
        transcriptionTime: Date.now() - audioStartTime
      },
      timestamp: admin.firestore.FieldValue.serverTimestamp(),
      intent: intentAnalysis.intent,
      context: intentAnalysis.context,
      conversationState: intentAnalysis.state,
      language: detectedLanguage,
      ethicalScore,
      botModeEnabled
    }));

    await updateCitizenEthicalScore(phoneNumber, ethicalScore);

    if (!botModeEnabled) {
      logger.warning(`🔕 Bot mode disabled for ${phoneNumber.replace(/^91/, 'XXX-XXX-')}. Audio message logged only.`);
      return;
    }

    // Process transcript based on intent
    if (intentAnalysis.intent === 'complaint') {
      await handleComplaintFlow(transcript, phoneNumber, displayName, intentAnalysis, detectedLanguage);
    } else {
      await handleGeneralConversation(transcript, phoneNumber, displayName, intentAnalysis, detectedLanguage);
    }

    const processingTime = Date.now() - audioStartTime;
    logger.success(`Audio message processed in ${processingTime}ms`);

  } catch (error) {
    const processingTime = Date.now() - audioStartTime;
    logger.critical('💥 Error processing audio message', { 
      error: error.message,
      stack: error.stack,
      phoneNumber: phoneNumber.replace(/^91/, 'XXX-XXX-'),
      processingTime
    });
    
    await sendTextMessage(phoneNumber, 
      'ऑडिओ प्रक्रिया करताना समस्या आली. कृपया मजकूर संदेश पाठवा.\n\nError processing audio. Please send a text message.'
    );
  } finally {
    // Clean up temporary audio file
    if (localAudioPath && fs.existsSync(localAudioPath)) {
      try {
        fs.unlinkSync(localAudioPath);
        logger.debug('🗑️ Temporary audio file cleaned up');
      } catch (cleanupError) {
        logger.warning('Failed to cleanup audio file', { 
          path: localAudioPath,
          error: cleanupError.message 
        });
      }
    }
  }
}

/**
 * Handle image messages with AI analysis - FIXED for undefined values
 */
async function handleImageMessage(message, phoneNumber, displayName, messageId) {
  const imageStartTime = Date.now();
  
  logger.ai('🖼️ Processing image message', { 
    phoneNumber: phoneNumber.replace(/^91/, 'XXX-XXX-'),
    mediaId: message.image.id,
    hasCaption: !!message.image.caption
  });

  try {
    const botModeEnabled = await getCitizenBotMode(phoneNumber);
    
    // Download and upload image
    logger.whatsapp('Downloading and uploading image...');
    const mediaUrl = await getMediaUrl(message.image.id);
    const imageUrl = await downloadAndUploadImage(mediaUrl, message.image.id);
    
    // Analyze image content with AI
    logger.ai('Analyzing image content with AI...');
    const imageAnalysis = await analyzeImageContent(imageUrl);
    
    // Combine image analysis with caption if present
    const caption = message.image.caption || ''; // Handle undefined caption
    const fullContent = caption ? 
      `${caption}\n\nImage Analysis: ${imageAnalysis}` : 
      `Image Analysis: ${imageAnalysis}`;
    
    const intentAnalysis = await analyzeIntent(fullContent, phoneNumber);
    const ethicalScore = await calculateEthicalScore(fullContent);
    const detectedLanguage = detectLanguage(fullContent);

    // Save message with proper handling of undefined values using sanitized data
    await saveChatMessage(phoneNumber, sanitizeFirestoreData({
      messageId,
      sender: phoneNumber,
      senderName: displayName,
      receiver: 'pcmc_bot',
      messageType: 'image',
      content: fullContent,
      imageUrl,
      imageMetadata: {
        mediaId: message.image.id,
        caption: caption || null, // Convert undefined to null
        hasCaption: !!message.image.caption,
        analysisTime: Date.now() - imageStartTime,
        fileSize: null // We don't have this info from WhatsApp
      },
      timestamp: admin.firestore.FieldValue.serverTimestamp(),
      intent: intentAnalysis.intent,
      context: intentAnalysis.context,
      conversationState: intentAnalysis.state,
      language: detectedLanguage,
      ethicalScore,
      botModeEnabled
    }));

    await updateCitizenEthicalScore(phoneNumber, ethicalScore);

    if (!botModeEnabled) {
      logger.warning(`🔕 Bot mode disabled for ${phoneNumber.replace(/^91/, 'XXX-XXX-')}. Image message logged only.`);
      return;
    }

    // Process image analysis
    if (intentAnalysis.intent === 'complaint') {
      await handleComplaintFlow(fullContent, phoneNumber, displayName, intentAnalysis, detectedLanguage, imageUrl);
    } else {
      await handleGeneralConversation(fullContent, phoneNumber, displayName, intentAnalysis, detectedLanguage);
    }

    const processingTime = Date.now() - imageStartTime;
    logger.success(`Image message processed in ${processingTime}ms`);

  } catch (error) {
    const processingTime = Date.now() - imageStartTime;
    logger.critical('💥 Error processing image message', { 
      error: error.message,
      stack: error.stack,
      phoneNumber: phoneNumber.replace(/^91/, 'XXX-XXX-'),
      processingTime
    });
    
    await sendTextMessage(phoneNumber,
      'प्रतिमा प्रक्रिया करताना समस्या आली. कृपया पुन्हा प्रयत्न करा.\n\nError processing image. Please try again.'
    );
  }
}

/**
 * Handle location messages - FIXED to only work with WhatsApp location sharing
 */
async function handleLocationMessage(message, phoneNumber, displayName, messageId) {
  const locationStartTime = Date.now();
  const latitude = message.location.latitude;
  const longitude = message.location.longitude;
  const locationName = message.location.name || null;
  const locationAddress = message.location.address || null;
  
  logger.ai('📍 Processing WhatsApp location message', { 
    phoneNumber: phoneNumber.replace(/^91/, 'XXX-XXX-'),
    latitude, 
    longitude,
    hasName: !!locationName,
    hasAddress: !!locationAddress
  });

  try {
    // Geocode location to get detailed address if not provided
    logger.firebase('Geocoding location coordinates...');
    const geocodedAddress = await geocodeAddress(latitude, longitude);
    const finalAddress = locationAddress || geocodedAddress;
    
    // Create proper location data object
    const locationData = {
      latitude,
      longitude,
      name: locationName,
      address: finalAddress,
      originalAddress: locationAddress,
      geocodedAddress: geocodedAddress,
      source: 'whatsapp_location',
      timestamp: new Date().toISOString()
    };
    
    // Save location message using sanitized data
    await saveChatMessage(phoneNumber, sanitizeFirestoreData({
      messageId,
      sender: phoneNumber,
      senderName: displayName,
      receiver: 'pcmc_bot',
      messageType: 'location',
      content: `Location shared: ${finalAddress}`,
      location: locationData,
      timestamp: admin.firestore.FieldValue.serverTimestamp(),
      intent: 'location_sharing',
      context: 'location_provided',
      conversationState: 'location_received',
      ethicalScore: 9,
      botModeEnabled: true
    }));

    // Check for pending complaints that need location
    logger.firebase('Checking for pending complaints needing location...');
    const pendingComplaint = await getPendingComplaintForUser(phoneNumber);
    
    if (pendingComplaint) {
      logger.complaint('Completing complaint with WhatsApp location...');
      
      // Complete complaint registration with WhatsApp location
      const ticketId = await confirmComplaint(pendingComplaint.id, locationData);

      const language = detectLanguage(pendingComplaint.description);
      const successMessage = language === 'marathi' ?
        `✅ तुमची तक्रार यशस्वीरित्या नोंदवली गेली!\n\n🎫 तिकीट ID: ${ticketId}\n📍 स्थान: ${finalAddress}\n🏛️ विभाग: ${pendingComplaint.department}\n⚡ प्राधान्यता: ${pendingComplaint.priority}\n\nपीसीएमसी ${pendingComplaint.estimatedResolutionTime} तासांत कार्यवाही करेल.\n\nआपल्या सहकार्याबद्दल धन्यवाद! 🙏` :
        `✅ Your complaint has been registered successfully!\n\n🎫 Ticket ID: ${ticketId}\n📍 Location: ${finalAddress}\n🏛️ Department: ${pendingComplaint.department}\n⚡ Priority: ${pendingComplaint.priority}\n\nPCMC will take action within ${pendingComplaint.estimatedResolutionTime} hours.\n\nThank you for your cooperation! 🙏`;

      await sendTextMessage(phoneNumber, successMessage);
      logger.success('Complaint completed with WhatsApp location', {
        ticketId,
        complaintId: pendingComplaint.id,
        location: `${latitude}, ${longitude}`
      });
    } else {
      // General location acknowledgment
      const areaInfo = await getAreaSpecificInfo(latitude, longitude);
      const response = `📍 स्थान प्राप्त झाले: ${finalAddress}\n\n${areaInfo}\n\nपीसीएमसी आज तुमची कशी मदत करू शकते?\n\n📍 Location received: ${finalAddress}\n\nHow can PCMC help you today?`;
      
      await sendTextMessage(phoneNumber, response);
      logger.ai('Location acknowledged with area info');
    }

    const processingTime = Date.now() - locationStartTime;
    logger.success(`Location message processed in ${processingTime}ms`);

  } catch (error) {
    const processingTime = Date.now() - locationStartTime;
    logger.critical('💥 Error processing location message', { 
      error: error.message,
      stack: error.stack,
      phoneNumber: phoneNumber.replace(/^91/, 'XXX-XXX-'),
      processingTime
    });
    
    await sendTextMessage(phoneNumber,
      'स्थान प्रक्रिया करताना समस्या आली. कृपया पुन्हा प्रयत्न करा.\n\nError processing location. Please try again.'
    );
  }
}

/**
 * Handle interactive button responses
 */
async function handleInteractiveMessage(message, phoneNumber, displayName, messageId) {
  const interactiveStartTime = Date.now();
  
  logger.ai('🔘 Processing interactive message', { 
    phoneNumber: phoneNumber.replace(/^91/, 'XXX-XXX-'),
    type: message.interactive.type
  });

  try {
    if (message.interactive.type === 'button_reply') {
      const buttonId = message.interactive.button_reply.id;
      const buttonTitle = message.interactive.button_reply.title;
      
      logger.ai('Button clicked', { buttonId, buttonTitle });

      // Save interaction using sanitized data
      await saveChatMessage(phoneNumber, sanitizeFirestoreData({
        messageId,
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
        timestamp: admin.firestore.FieldValue.serverTimestamp(),
        intent: 'button_interaction',
        context: 'user_confirmation',
        conversationState: buttonId.includes('confirm') ? 'confirmed' : 'cancelled',
        ethicalScore: 9,
        botModeEnabled: true
      }));

      // Handle specific button actions
      if (buttonId.startsWith('confirm_complaint_')) {
        const complaintId = buttonId.replace('confirm_complaint_', '');
        logger.complaint('Processing complaint confirmation...');
        await handleComplaintConfirmation(complaintId, phoneNumber);
      } else if (buttonId.startsWith('cancel_complaint_')) {
        const complaintId = buttonId.replace('cancel_complaint_', '');
        logger.complaint('Processing complaint cancellation...');
        await handleComplaintCancellation(complaintId, phoneNumber);
      } else if (buttonId.startsWith('department_')) {
        const department = buttonId.replace('department_', '');
        logger.ai('Processing department selection...');
        await handleDepartmentSelection(department, phoneNumber);
      } else if (buttonId === 'share_location') {
        logger.ai('Processing location sharing request...');
        await handleLocationSharingRequest(phoneNumber);
      } else {
        logger.warning('Unknown button interaction', { buttonId });
        await sendTextMessage(phoneNumber, 
          'माफ करा, हे बटण ओळखले गेले नाही. कृपया पुन्हा प्रयत्न करा.\n\nSorry, this button was not recognized. Please try again.'
        );
      }

    } else if (message.interactive.type === 'list_reply') {
      const listId = message.interactive.list_reply.id;
      const listTitle = message.interactive.list_reply.title;
      
      logger.ai('List item selected', { listId, listTitle });
      
      // Handle list selections
      await handleListSelection(listId, listTitle, phoneNumber, displayName);
    }

    const processingTime = Date.now() - interactiveStartTime;
    logger.success(`Interactive message processed in ${processingTime}ms`);

  } catch (error) {
    const processingTime = Date.now() - interactiveStartTime;
    logger.critical('💥 Error processing interactive message', { 
      error: error.message,
      stack: error.stack,
      phoneNumber: phoneNumber.replace(/^91/, 'XXX-XXX-'),
      processingTime
    });
    
    await sendTextMessage(phoneNumber,
      'इंटरॅक्टिव्ह संदेश प्रक्रिया करताना समस्या आली.\n\nError processing interactive message.'
    );
  }
}

/**
 * Handle document messages
 */
async function handleDocumentMessage(message, phoneNumber, displayName, messageId) {
  logger.ai('📄 Document message received', {
    phoneNumber: phoneNumber.replace(/^91/, 'XXX-XXX-'),
    mediaId: message.document.id,
    filename: message.document.filename,
    mimeType: message.document.mime_type
  });

  try {
    // Save document message using sanitized data
    await saveChatMessage(phoneNumber, sanitizeFirestoreData({
      messageId,
      sender: phoneNumber,
      senderName: displayName,
      receiver: 'pcmc_bot',
      messageType: 'document',
      content: `Document shared: ${message.document.filename || 'Untitled'}`,
      documentMetadata: {
        mediaId: message.document.id,
        filename: message.document.filename || null,
        mimeType: message.document.mime_type || null,
        caption: message.document.caption || null
      },
      timestamp: admin.firestore.FieldValue.serverTimestamp(),
      intent: 'document_sharing',
      context: 'document_upload',
      conversationState: 'document_received',
      ethicalScore: 8,
      botModeEnabled: true
    }));

    const response = message.document.filename ?
      `📄 दस्तऐवज प्राप्त झाला: ${message.document.filename}\n\nआम्ही तुमचा दस्तऐवज नोंदवला आहे. PCMC कर्मचारी त्याचे परीक्षण करतील.\n\n📄 Document received: ${message.document.filename}\n\nWe have logged your document. PCMC staff will review it.` :
      `📄 दस्तऐवज प्राप्त झाला.\n\nआम्ही तुमचा दस्तऐवज नोंदवला आहे.\n\n📄 Document received.\n\nWe have logged your document.`;

    await sendTextMessage(phoneNumber, response);

  } catch (error) {
    logger.critical('Error processing document message', { 
      error: error.message,
      phoneNumber: phoneNumber.replace(/^91/, 'XXX-XXX-')
    });
    
    await sendTextMessage(phoneNumber,
      'दस्तऐवज प्रक्रिया करताना समस्या आली.\n\nError processing document.'
    );
  }
}

/**
 * Handle video messages
 */
async function handleVideoMessage(message, phoneNumber, displayName, messageId) {
  logger.ai('🎥 Video message received', {
    phoneNumber: phoneNumber.replace(/^91/, 'XXX-XXX-'),
    mediaId: message.video.id,
    mimeType: message.video.mime_type
  });

  try {
    // Save video message using sanitized data
    await saveChatMessage(phoneNumber, sanitizeFirestoreData({
      messageId,
      sender: phoneNumber,
      senderName: displayName,
      receiver: 'pcmc_bot',
      messageType: 'video',
      content: `Video shared${message.video.caption ? ': ' + message.video.caption : ''}`,
      videoMetadata: {
        mediaId: message.video.id,
        mimeType: message.video.mime_type || null,
        caption: message.video.caption || null
      },
      timestamp: admin.firestore.FieldValue.serverTimestamp(),
      intent: 'media_sharing',
      context: 'video_upload',
      conversationState: 'video_received',
      ethicalScore: 8,
      botModeEnabled: true
    }));

    await sendTextMessage(phoneNumber, 
      '🎥 व्हिडिओ प्राप्त झाला. आम्ही तुमचा व्हिडिओ नोंदवला आहे.\n\n🎥 Video received. We have logged your video.'
    );

  } catch (error) {
    logger.critical('Error processing video message', { 
      error: error.message,
      phoneNumber: phoneNumber.replace(/^91/, 'XXX-XXX-')
    });
    
    await sendTextMessage(phoneNumber,
      'व्हिडिओ प्रक्रिया करताना समस्या आली.\n\nError processing video.'
    );
  }
}

/**
 * Handle sticker messages
 */
async function handleStickerMessage(message, phoneNumber, displayName, messageId) {
  logger.ai('😀 Sticker message received', {
    phoneNumber: phoneNumber.replace(/^91/, 'XXX-XXX-'),
    mediaId: message.sticker.id
  });

  try {
    // Save sticker message using sanitized data
    await saveChatMessage(phoneNumber, sanitizeFirestoreData({
      messageId,
      sender: phoneNumber,
      senderName: displayName,
      receiver: 'pcmc_bot',
      messageType: 'sticker',
      content: 'Sticker sent',
      stickerMetadata: {
        mediaId: message.sticker.id,
        animated: message.sticker.animated || false
      },
      timestamp: admin.firestore.FieldValue.serverTimestamp(),
      intent: 'expression',
      context: 'sticker_sharing',
      conversationState: 'sticker_received',
      ethicalScore: 8,
      botModeEnabled: true
    }));

    await sendTextMessage(phoneNumber, 
      '😊 स्टिकर पाहिला! पीसीएमसी आज तुमची कशी मदत करू शकते?\n\n😊 Sticker received! How can PCMC help you today?'
    );

  } catch (error) {
    logger.critical('Error processing sticker message', { 
      error: error.message,
      phoneNumber: phoneNumber.replace(/^91/, 'XXX-XXX-')
    });
  }
}

/**
 * Handle contact messages
 */
async function handleContactMessage(message, phoneNumber, displayName, messageId) {
  logger.ai('👥 Contact message received', {
    phoneNumber: phoneNumber.replace(/^91/, 'XXX-XXX-'),
    contactCount: message.contacts.length
  });

  try {
    const contactNames = message.contacts.map(contact => 
      contact.name?.formatted_name || 'Unknown Contact'
    ).join(', ');

    // Save contact message using sanitized data
    await saveChatMessage(phoneNumber, sanitizeFirestoreData({
      messageId,
      sender: phoneNumber,
      senderName: displayName,
      receiver: 'pcmc_bot',
      messageType: 'contacts',
      content: `Contacts shared: ${contactNames}`,
      contactsMetadata: {
        contactCount: message.contacts.length,
        contacts: message.contacts
      },
      timestamp: admin.firestore.FieldValue.serverTimestamp(),
      intent: 'contact_sharing',
      context: 'contact_info',
      conversationState: 'contacts_received',
      ethicalScore: 8,
      botModeEnabled: true
    }));

    await sendTextMessage(phoneNumber, 
      `👥 संपर्क माहिती प्राप्त झाली: ${contactNames}\n\nआम्ही तुमची संपर्क माहिती नोंदवली आहे.\n\n👥 Contact information received: ${contactNames}\n\nWe have logged your contact information.`
    );

  } catch (error) {
    logger.critical('Error processing contact message', { 
      error: error.message,
      phoneNumber: phoneNumber.replace(/^91/, 'XXX-XXX-')
    });
  }
}

/**
 * Send unsupported message type response
 */
async function sendUnsupportedMessageResponse(phoneNumber, messageType) {
  const response = `माफ करा, "${messageType}" प्रकारचा संदेश सध्या समर्थित नाही.\n\nकृपया खालील संदेश प्रकार वापरा:\n• मजकूर संदेश\n• ऑडिओ संदेश\n• प्रतिमा\n• स्थान\n• दस्तऐवज\n\nSorry, "${messageType}" message type is not currently supported.\n\nPlease use:\n• Text messages\n• Audio messages\n• Images\n• Location\n• Documents`;

  await sendTextMessage(phoneNumber, response);
}

/**
 * Handle complaint registration flow
 */
async function handleComplaintFlow(messageText, phoneNumber, displayName, intentAnalysis, language, imageUrl = null) {
  try {
    logger.complaint('🎯 Starting complaint flow...');
    
    // Check for duplicate complaints
    logger.firebase('Checking for duplicate complaints...');
    const duplicateCheck = await checkDuplicateComplaint(messageText, phoneNumber);
    
    if (duplicateCheck.isDuplicate) {
      const responseMessage = language === 'marathi' ? 
        `🔄 या विषयावर आधीच तक्रार नोंदवली आहे (तिकीट: ${duplicateCheck.ticketId}).\n\nस्थिती: ${duplicateCheck.status}\nसमानता: ${Math.round(duplicateCheck.similarity * 100)}%\n\nआम्ही तुम्हाला अपडेटच्या यादीत जोडले आहे. 📋` :
        `🔄 A complaint on this issue is already registered (Ticket: ${duplicateCheck.ticketId}).\n\nStatus: ${duplicateCheck.status}\nSimilarity: ${Math.round(duplicateCheck.similarity * 100)}%\n\nWe've added you to the updates list. 📋`;
      
      await sendTextMessage(phoneNumber, responseMessage);
      logger.complaint('Duplicate complaint detected and user notified', {
        similarityScore: duplicateCheck.similarity,
        existingTicket: duplicateCheck.ticketId
      });
      return;
    }

    // Create draft complaint
    logger.firebase('Creating draft complaint...');
    const draftComplaint = await createDraftComplaint(messageText, phoneNumber, intentAnalysis, imageUrl);
    
    // Send confirmation request with enhanced information
    logger.whatsapp('Sending complaint confirmation...');
    const confirmationText = language === 'marathi' ? 
      `📝 तक्रार नोंदवणी पुष्टी\n\n🎯 तुमची तक्रार:\n"${messageText.substring(0, 200)}${messageText.length > 200 ? '...' : ''}"\n\n🏛️ विभाग: ${draftComplaint.department}\n⚡ प्राधान्यता: ${getPriorityEmoji(draftComplaint.priority)} ${draftComplaint.priority.toUpperCase()}\n📊 श्रेणी: ${draftComplaint.category}\n⏱️ अपेक्षित निराकरण: ${draftComplaint.estimatedResolutionTime} तास\n\nही तक्रार नोंदवायची आहे का?` :
      `📝 Complaint Registration Confirmation\n\n🎯 Your complaint:\n"${messageText.substring(0, 200)}${messageText.length > 200 ? '...' : ''}"\n\n🏛️ Department: ${draftComplaint.department}\n⚡ Priority: ${getPriorityEmoji(draftComplaint.priority)} ${draftComplaint.priority.toUpperCase()}\n📊 Category: ${draftComplaint.category}\n⏱️ Expected resolution: ${draftComplaint.estimatedResolutionTime} hours\n\nDo you want to register this complaint?`;

    const buttons = [
      {
        type: 'reply',
        reply: {
          id: `confirm_complaint_${draftComplaint.id}`,
          title: language === 'marathi' ? '✅ होय, नोंदवा' : '✅ Yes, Register'
        }
      },
      {
        type: 'reply',
        reply: {
          id: `cancel_complaint_${draftComplaint.id}`,
          title: language === 'marathi' ? '❌ रद्द करा' : '❌ Cancel'
        }
      }
    ];

    await sendQuickReply(phoneNumber, confirmationText, buttons);
    logger.success('Complaint confirmation sent successfully', {
      complaintId: draftComplaint.id,
      department: draftComplaint.department,
      priority: draftComplaint.priority
    });

  } catch (error) {
    logger.critical('💥 Error in complaint flow', { 
      error: error.message, 
      stack: error.stack,
      phoneNumber: phoneNumber.replace(/^91/, 'XXX-XXX-')
    });
    
    const errorMessage = language === 'marathi' ? 
      'तक्रार प्रक्रियेत समस्या आली. कृपया पुन्हा प्रयत्न करा.' :
      'Error processing complaint. Please try again.';
    await sendTextMessage(phoneNumber, errorMessage);
  }
}

/**
 * Handle general conversations with AI
 */
async function handleGeneralConversation(messageText, phoneNumber, displayName, intentAnalysis, language) {
  try {
    logger.ai('🔄 Starting general conversation handling...');
    
    // Get conversation context
    logger.firebase('Getting conversation context...');
    const conversationContext = await getConversationContext(phoneNumber, 5);
    
    // Process with AI
    logger.ai('Processing message with AI...');
    const aiResponse = await processMessageWithAI(
      messageText, 
      phoneNumber, 
      intentAnalysis, 
      conversationContext,
      language
    );

    // Check if AI suggests location-based service
    if (aiResponse.requiresLocation) {
      logger.whatsapp('Sending location request based on AI suggestion...');
      await sendLocationRequest(phoneNumber, aiResponse.locationPrompt);
      return;
    }

    // Send AI response
    logger.whatsapp('Sending AI response...');
    await sendTextMessage(phoneNumber, aiResponse.message);

    // Log bot response using sanitized data
    logger.firebase('Logging bot response...');
    await saveChatMessage(phoneNumber, sanitizeFirestoreData({
      messageId: generateTicketId(8),
      sender: 'pcmc_bot',
      senderName: 'PCMC Assistant',
      receiver: phoneNumber,
      messageType: 'text',
      content: aiResponse.message,
      timestamp: admin.firestore.FieldValue.serverTimestamp(),
      intent: 'response',
      context: intentAnalysis.context,
      conversationState: 'completed',
      language,
      ethicalScore: 10, // Bot messages are always ethical
      botModeEnabled: true,
      aiMetadata: {
        originalIntent: intentAnalysis.intent,
        processingTime: Date.now() - Date.now()
      }
    }));

    logger.success('General conversation completed successfully');

  } catch (error) {
    logger.critical('💥 Error in general conversation', { 
      error: error.message,
      stack: error.stack,
      phoneNumber: phoneNumber.replace(/^91/, 'XXX-XXX-')
    });
    
    const errorMessage = language === 'marathi' ? 
      'माफ करा, मी सध्या मदत करू शकत नाही. कृपया पुन्हा प्रयत्न करा.' :
      'Sorry, I cannot help right now. Please try again.';
    await sendTextMessage(phoneNumber, errorMessage);
  }
}

/**
 * Handle query flow with knowledge base
 */
async function handleQueryFlow(messageText, phoneNumber, displayName, intentAnalysis, language) {
  try {
    logger.ai('❓ Processing information query...');
    
    // Get conversation context for better responses
    const conversationContext = await getConversationContext(phoneNumber, 3);
    
    // Process with AI using knowledge base
    const aiResponse = await processMessageWithAI(
      messageText, 
      phoneNumber, 
      intentAnalysis, 
      conversationContext,
      language
    );

    await sendTextMessage(phoneNumber, aiResponse.message);

    // Log interaction using sanitized data
    await saveChatMessage(phoneNumber, sanitizeFirestoreData({
      messageId: generateTicketId(8),
      sender: 'pcmc_bot',
      senderName: 'PCMC Assistant',
      receiver: phoneNumber,
      messageType: 'text',
      content: aiResponse.message,
      timestamp: admin.firestore.FieldValue.serverTimestamp(),
      intent: 'query_response',
      context: intentAnalysis.context,
      conversationState: 'query_completed',
      language,
      ethicalScore: 10,
      botModeEnabled: true
    }));

    logger.success('Query processed successfully');

  } catch (error) {
    logger.critical('Error in query flow', { 
      error: error.message,
      phoneNumber: phoneNumber.replace(/^91/, 'XXX-XXX-')
    });
    
    const errorMessage = language === 'marathi' ? 
      'माहिती मिळविताना समस्या आली. कृपया पुन्हा प्रयत्न करा.' :
      'Error retrieving information. Please try again.';
    await sendTextMessage(phoneNumber, errorMessage);
  }
}

/**
 * Handle greeting flow
 */
async function handleGreetingFlow(messageText, phoneNumber, displayName, intentAnalysis, language) {
  try {
    logger.ai('👋 Processing greeting...');
    
    const greeting = language === 'marathi' ? 
      `🙏 नमस्कार ${displayName}!\n\nपिंपरी-चिंचवड महानगरपालिकेत (PCMC) आपले स्वागत आहे! 🏛️\n\nमी आपला AI सहाय्यक आहे. मी खालील बाबतीत मदत करू शकतो:\n\n• 📝 तक्रारी नोंदवणे\n• ℹ️ PCMC सेवांची माहिती\n• 📞 संपर्क तपशील\n• 🏢 कार्यालयीन वेळापत्रक\n• 💰 कर भरणा\n• 📋 प्रमाणपत्रे\n\nआज मी तुमची कशी मदत करू शकतो?` :
      `🙏 Hello ${displayName}!\n\nWelcome to Pimpri-Chinchwad Municipal Corporation (PCMC)! 🏛️\n\nI'm your AI assistant. I can help you with:\n\n• 📝 Register complaints\n• ℹ️ PCMC services information\n• 📞 Contact details\n• 🏢 Office timings\n• 💰 Tax payments\n• 📋 Certificates\n\nHow can I help you today?`;

    await sendTextMessage(phoneNumber, greeting);

    // Log greeting interaction using sanitized data
    await saveChatMessage(phoneNumber, sanitizeFirestoreData({
      messageId: generateTicketId(8),
      sender: 'pcmc_bot',
      senderName: 'PCMC Assistant',
      receiver: phoneNumber,
      messageType: 'text',
      content: greeting,
      timestamp: admin.firestore.FieldValue.serverTimestamp(),
      intent: 'greeting_response',
      context: 'welcome',
      conversationState: 'greeted',
      language,
      ethicalScore: 10,
      botModeEnabled: true
    }));

    logger.success('Greeting processed successfully');

  } catch (error) {
    logger.critical('Error in greeting flow', { 
      error: error.message,
      phoneNumber: phoneNumber.replace(/^91/, 'XXX-XXX-')
    });
  }
}

/**
 * Handle small talk flow
 */
async function handleSmallTalkFlow(messageText, phoneNumber, displayName, intentAnalysis, language) {
  try {
    logger.ai('💬 Processing small talk...');
    
    // Get context for more natural responses
    const conversationContext = await getConversationContext(phoneNumber, 3);
    
    // Process with AI for natural conversation
    const aiResponse = await processMessageWithAI(
      messageText, 
      phoneNumber, 
      intentAnalysis, 
      conversationContext,
      language
    );

    await sendTextMessage(phoneNumber, aiResponse.message);

    // Log interaction using sanitized data
    await saveChatMessage(phoneNumber, sanitizeFirestoreData({
      messageId: generateTicketId(8),
      sender: 'pcmc_bot',
      senderName: 'PCMC Assistant',
      receiver: phoneNumber,
      messageType: 'text',
      content: aiResponse.message,
      timestamp: admin.firestore.FieldValue.serverTimestamp(),
      intent: 'small_talk_response',
      context: intentAnalysis.context,
      conversationState: 'casual_chat',
      language,
      ethicalScore: 10,
      botModeEnabled: true
    }));

    logger.success('Small talk processed successfully');

  } catch (error) {
    logger.critical('Error in small talk flow', { 
      error: error.message,
      phoneNumber: phoneNumber.replace(/^91/, 'XXX-XXX-')
    });
  }
}

/**
 * Handle complaint confirmation - UPDATED to only request WhatsApp location
 */
async function handleComplaintConfirmation(complaintId, phoneNumber) {
  try {
    logger.complaint('Processing complaint confirmation...', { complaintId });
    
    const complaint = await getDraftComplaint(complaintId);
    
    if (!complaint) {
      await sendTextMessage(phoneNumber, 
        'तक्रार सापडली नाही. कृपया पुन्हा प्रयत्न करा.\n\nComplaint not found. Please try again.'
      );
      return;
    }

    const language = detectLanguage(complaint.description);
    
    // ONLY request WhatsApp location sharing - no text address option
    const locationMessage = language === 'marathi' ?
      `✅ तक्रार पुष्ट केली!\n\n📍 आता कृपया तुमचे अचूक स्थान शेअर करा:\n\n1️⃣ WhatsApp मध्ये 📎 (attach) बटणावर क्लिक करा\n2️⃣ "Location" निवडा\n3️⃣ "Send your current location" निवडा\n\nकिंवा मेसेज बॉक्समध्ये 📍 आयकॉनवर क्लिक करा\n\n⚠️ कृपया फक्त WhatsApp चे location feature वापरा` :
      `✅ Complaint confirmed!\n\n📍 Now please share your exact location:\n\n1️⃣ Click 📎 (attach) button in WhatsApp\n2️⃣ Select "Location"\n3️⃣ Choose "Send your current location"\n\nOr click 📍 icon in message box\n\n⚠️ Please only use WhatsApp's location feature`;

    await sendTextMessage(phoneNumber, locationMessage);
    
    logger.success('Complaint confirmation processed - location request sent', { complaintId });

  } catch (error) {
    logger.critical('Error confirming complaint', { 
      error: error.message, 
      complaintId, 
      phoneNumber: phoneNumber.replace(/^91/, 'XXX-XXX-')
    });
  }
}

/**
 * Handle complaint cancellation
 */
async function handleComplaintCancellation(complaintId, phoneNumber) {
  try {
    logger.complaint('Processing complaint cancellation...', { complaintId });
    
    await cancelComplaint(complaintId);
    
    await sendTextMessage(phoneNumber,
      `❌ तक्रार रद्द केली.\n\nकोणत्याही प्रश्नासाठी आम्ही इथे आहोत. पीसीएमसी आज तुमची कशी मदत करू शकते?\n\n❌ Complaint cancelled.\n\nWe're here for any questions. How can PCMC help you today?`
    );
    
    logger.success('Complaint cancellation processed', { complaintId });

  } catch (error) {
    logger.critical('Error cancelling complaint', { 
      error: error.message, 
      complaintId, 
      phoneNumber: phoneNumber.replace(/^91/, 'XXX-XXX-')
    });
  }
}

/**
 * Handle department selection
 */
async function handleDepartmentSelection(department, phoneNumber) {
  try {
    logger.ai('Processing department selection...', { department });
    
    const departmentInfo = getDepartmentInfo(department);
    
    if (departmentInfo) {
      const response = `🏛️ ${departmentInfo.name}\n\n📞 संपर्क: ${departmentInfo.contact}\n📧 ईमेल: ${departmentInfo.email}\n⏰ वेळ: ${departmentInfo.timings}\n\n📝 सेवा:\n${departmentInfo.services.map(service => `• ${service}`).join('\n')}\n\nया विभागाबाबत काही प्रश्न आहे का?`;
      
      await sendTextMessage(phoneNumber, response);
    } else {
      await sendTextMessage(phoneNumber, 
        'माफ करा, या विभागाची माहिती सापडली नाही.\n\nSorry, information for this department was not found.'
      );
    }
    
  } catch (error) {
    logger.critical('Error processing department selection', { 
      error: error.message, 
      department,
      phoneNumber: phoneNumber.replace(/^91/, 'XXX-XXX-')
    });
  }
}

/**
 * Handle location sharing request - UPDATED with clearer instructions
 */
async function handleLocationSharingRequest(phoneNumber) {
  try {
    const message = `📍 कृपया तुमचे स्थान शेअर करा | Please share your location:\n\n🔹 WhatsApp मध्ये:\n1. 📎 (attach) बटणावर क्लिक करा\n2. "Location" निवडा\n3. "Send your current location" निवडा\n\n🔹 In WhatsApp:\n1. Click 📎 (attach) button\n2. Select "Location"\n3. Choose "Send your current location"\n\n⚠️ महत्वाचे: कृपया फक्त WhatsApp चे location sharing feature वापरा\n⚠️ Important: Please only use WhatsApp's location sharing feature`;

    await sendTextMessage(phoneNumber, message);
    
    logger.ai('Clear location sharing instructions sent');
    
  } catch (error) {
    logger.critical('Error handling location sharing request', { 
      error: error.message,
      phoneNumber: phoneNumber.replace(/^91/, 'XXX-XXX-')
    });
  }
}

/**
 * Handle list selection
 */
async function handleListSelection(listId, listTitle, phoneNumber, displayName) {
  try {
    logger.ai('Processing list selection...', { listId, listTitle });
    
    // Save list selection using sanitized data
    await saveChatMessage(phoneNumber, sanitizeFirestoreData({
      messageId: generateTicketId(8),
      sender: phoneNumber,
      senderName: displayName,
      receiver: 'pcmc_bot',
      messageType: 'interactive',
      content: `List item selected: ${listTitle}`,
      interactiveData: { 
        type: 'list_reply',
        listId, 
        listTitle 
      },
      timestamp: admin.firestore.FieldValue.serverTimestamp(),
      intent: 'list_selection',
      context: 'menu_navigation',
      conversationState: 'list_selected',
      ethicalScore: 9,
      botModeEnabled: true
    }));

    // Handle specific list selections
    if (listId.startsWith('service_')) {
      const service = listId.replace('service_', '');
      await handleServiceSelection(service, phoneNumber);
    } else if (listId.startsWith('department_')) {
      const department = listId.replace('department_', '');
      await handleDepartmentSelection(department, phoneNumber);
    } else {
      await sendTextMessage(phoneNumber, 
        `तुम्ही "${listTitle}" निवडले आहे. अधिक माहितीसाठी कृपया प्रतीक्षा करा.\n\nYou selected "${listTitle}". Please wait for more information.`
      );
    }
    
  } catch (error) {
    logger.critical('Error processing list selection', { 
      error: error.message,
      listId,
      phoneNumber: phoneNumber.replace(/^91/, 'XXX-XXX-')
    });
  }
}

/**
 * Handle service selection
 */
// Continuing from handleServiceSelection function...

/**
 * Handle service selection
 */
async function handleServiceSelection(service, phoneNumber) {
  try {
    logger.ai('Processing service selection...', { service });
    
    const serviceInfo = getServiceInfo(service);
    
    if (serviceInfo) {
      const response = `🔧 ${serviceInfo.name}\n\n📋 वर्णन: ${serviceInfo.description}\n🏛️ विभाग: ${serviceInfo.department}\n💰 फी: ${serviceInfo.fee}\n📄 आवश्यक कागदपत्रे:\n${serviceInfo.documents.map(doc => `• ${doc}`).join('\n')}\n⏱️ प्रक्रिया वेळ: ${serviceInfo.processingTime}\n\nया सेवेसाठी अर्ज करायचा आहे का?`;
      
      await sendTextMessage(phoneNumber, response);
    } else {
      await sendTextMessage(phoneNumber, 
        'माफ करा, या सेवेची माहिती सापडली नाही.\n\nSorry, information for this service was not found.'
      );
    }
    
  } catch (error) {
    logger.critical('Error processing service selection', { 
      error: error.message, 
      service,
      phoneNumber: phoneNumber.replace(/^91/, 'XXX-XXX-')
    });
  }
}

/**
 * Process message status updates
 */
async function processMessageStatus(body) {
  try {
    const statusData = body.entry[0].changes[0].value.statuses[0];
    const messageId = statusData.id;
    const status = statusData.status;
    const timestamp = statusData.timestamp;
    const recipientId = statusData.recipient_id;

    logger.whatsapp('📊 Message status update received', { 
      messageId, 
      status,
      timestamp: new Date(parseInt(timestamp) * 1000).toISOString(),
      recipient: recipientId.replace(/^91/, 'XXX-XXX-')
    });

    // Log different status types
    switch (status) {
      case 'sent':
        logger.whatsapp('✅ Message sent successfully', { messageId });
        break;
      case 'delivered':
        logger.whatsapp('📬 Message delivered', { messageId });
        break;
      case 'read':
        logger.whatsapp('👁️ Message read by user', { messageId });
        break;
      case 'failed':
        logger.critical('❌ Message delivery failed', { 
          messageId,
          error: statusData.errors?.[0] || 'Unknown error'
        });
        break;
      default:
        logger.whatsapp(`📊 Unknown status: ${status}`, { messageId });
    }

    // Optional: Update message status in database
    await updateMessageStatus(messageId, status, timestamp);

  } catch (error) {
    logger.critical('💥 Error processing message status', {
      error: error.message,
      stack: error.stack,
      statusData: body.entry?.[0]?.changes?.[0]?.value?.statuses?.[0]
    });
  }
}

/**
 * Get pending complaint for user that needs location - UPDATED query
 */
async function getPendingComplaintForUser(phoneNumber) {
  try {
    logger.firebase('Checking for pending complaints needing location...', {
      phoneNumber: phoneNumber.replace(/^91/, 'XXX-XXX-')
    });

    const complaintsRef = admin.firestore().collection('complaints');
    const query = complaintsRef
      .where('createdBy', '==', phoneNumber)
      .where('status', '==', 'draft')
      .where('requiresLocationSharing', '==', true) // New field to track location requirement
      .orderBy('createdAt', 'desc')
      .limit(1);

    const snapshot = await query.get();
    
    if (!snapshot.empty) {
      const complaint = snapshot.docs[0].data();
      logger.firebase('Found pending complaint needing location', { 
        complaintId: complaint.id,
        department: complaint.department
      });
      return complaint;
    }

    logger.firebase('No pending complaints found requiring location');
    return null;
  } catch (error) {
    logger.critical('Error getting pending complaint', { 
      error: error.message,
      phoneNumber: phoneNumber.replace(/^91/, 'XXX-XXX-')
    });
    return null;
  }
}

/**
 * Get draft complaint by ID
 */
async function getDraftComplaint(complaintId) {
  try {
    logger.firebase('Getting draft complaint', { complaintId });

    const complaintRef = admin.firestore().collection('complaints').doc(complaintId);
    const complaintDoc = await complaintRef.get();
    
    if (complaintDoc.exists) {
      const complaint = complaintDoc.data();
      logger.firebase('Draft complaint found', { 
        complaintId,
        status: complaint.status,
        department: complaint.department
      });
      return complaint;
    }

    logger.warning('Draft complaint not found', { complaintId });
    return null;
  } catch (error) {
    logger.critical('Error getting draft complaint', { 
      error: error.message,
      complaintId
    });
    return null;
  }
}

/**
 * Get area-specific information based on coordinates
 */
async function getAreaSpecificInfo(latitude, longitude) {
  try {
    logger.firebase('Getting area-specific information', { latitude, longitude });

    // Area detection based on coordinates for PCMC region
    const areas = {
      'pimpri': { 
        lat: 18.6298, lng: 73.8022, 
        info: 'पिंपरी क्षेत्र - मुख्य शहरी भाग | Pimpri Area - Main Urban Zone',
        wardInfo: 'वॉर्ड 1-15 | Wards 1-15'
      },
      'chinchwad': { 
        lat: 18.6186, lng: 73.7937, 
        info: 'चिंचवड क्षेत्र - औद्योगिक भाग | Chinchwad Area - Industrial Zone',
        wardInfo: 'वॉर्ड 16-30 | Wards 16-30'
      },
      'akurdi': { 
        lat: 18.6476, lng: 73.7693, 
        info: 'अकुर्डी क्षेत्र - निवासी भाग | Akurdi Area - Residential Zone',
        wardInfo: 'वॉर्ड 31-45 | Wards 31-45'
      },
      'bhosari': { 
        lat: 18.6268, lng: 73.8354, 
        info: 'भोसरी क्षेत्र - MIDC औद्योगिक भाग | Bhosari Area - MIDC Industrial Zone',
        wardInfo: 'वॉर्ड 46-60 | Wards 46-60'
      },
      'wakad': { 
        lat: 18.5975, lng: 73.7553, 
        info: 'वाकड क्षेत्र - IT हब | Wakad Area - IT Hub',
        wardInfo: 'वॉर्ड 61-75 | Wards 61-75'
      },
      'hinjewadi': { 
        lat: 18.5908, lng: 73.7329, 
        info: 'हिंजेवाडी क्षेत्र - तंत्रज्ञान पार्क | Hinjawadi Area - Technology Park',
        wardInfo: 'वॉर्ड 76-90 | Wards 76-90'
      },
      'nigdi': {
        lat: 18.6583, lng: 73.7667,
        info: 'निगडी क्षेत्र - व्यापारिक केंद्र | Nigdi Area - Commercial Center',
        wardInfo: 'वॉर्ड 91-105 | Wards 91-105'
      },
      'pune_airport': {
        lat: 18.5821, lng: 73.9197,
        info: 'पुणे विमानतळ क्षेत्र | Pune Airport Area',
        wardInfo: 'वॉर्ड 106-120 | Wards 106-120'
      }
    };

    let closestArea = 'general';
    let minDistance = Infinity;
    let areaDetails = null;

    for (const [areaName, areaData] of Object.entries(areas)) {
      const distance = Math.sqrt(
        Math.pow(latitude - areaData.lat, 2) + Math.pow(longitude - areaData.lng, 2)
      );
      
      if (distance < minDistance) {
        minDistance = distance;
        closestArea = areaName;
        areaDetails = areaData;
      }
    }

    if (minDistance < 0.05 && areaDetails) { // Within ~5km
      logger.firebase('Area identified', { area: closestArea, distance: minDistance });
      return `📍 ${areaDetails.info}\n🏛️ ${areaDetails.wardInfo}`;
    }

    return '📍 PCMC क्षेत्र | PCMC Area\n🏛️ पिंपरी-चिंचवड महानगरपालिका';
  } catch (error) {
    logger.critical('Error getting area info', { error: error.message });
    return '📍 PCMC क्षेत्र | PCMC Area';
  }
}

/**
 * Get priority emoji based on priority level
 */
function getPriorityEmoji(priority) {
  const emojis = {
    'emergency': '🚨',
    'high': '🔴',
    'medium': '🟡',
    'low': '🟢'
  };
  return emojis[priority] || '🟡';
}

/**
 * Get department information
 */
function getDepartmentInfo(department) {
  const departments = {
    'water_supply': {
      name: 'पाणीपुरवठा विभाग | Water Supply Department',
      contact: '020-27475201',
      email: 'water@pcmcindia.gov.in',
      timings: 'सकाळी 10 ते संध्याकाळी 5:30 | 10 AM to 5:30 PM',
      services: [
        'नवीन पाणी कनेक्शन | New water connections',
        'मीटर बसवणे | Meter installations', 
        'पाणी गुणवत्ता तपासणी | Water quality testing',
        'गळती दुरुस्ती | Leak repairs',
        'बिल भरणा | Bill payments'
      ]
    },
    'waste_management': {
      name: 'घनकचरा व्यवस्थापन विभाग | Waste Management Department',
      contact: '020-27475202',
      email: 'waste@pcmcindia.gov.in',
      timings: 'सकाळी 6 ते संध्याकाळी 8 | 6 AM to 8 PM',
      services: [
        'घरोघरी कचरा संकलन | Door-to-door collection',
        'कचरा विभक्तीकरण | Waste segregation',
        'रस्ता साफसफाई | Street cleaning',
        'सार्वजनिक शौचालय | Public toilets',
        'कचरा प्रक्रिया केंद्र | Waste processing centers'
      ]
    },
    'roads_infrastructure': {
      name: 'रस्ते आणि पायाभूत सुविधा विभाग | Roads & Infrastructure Department',
      contact: '020-27475203',
      email: 'roads@pcmcindia.gov.in',
      timings: 'सकाळी 10 ते संध्याकाळी 5:30 | 10 AM to 5:30 PM',
      services: [
        'रस्ता बांधकाम | Road construction',
        'रस्ता दुरुस्ती | Road repairs',
        'रस्ता दिवे | Street lighting',
        'वाहतूक व्यवस्थापन | Traffic management',
        'फुटपाथ व पुल | Footpaths & bridges'
      ]
    },
    'health_sanitation': {
      name: 'आरोग्य आणि स्वच्छता विभाग | Health & Sanitation Department',
      contact: '020-27475204',
      email: 'health@pcmcindia.gov.in',
      timings: 'सकाळी 8 ते संध्याकाळी 6 | 8 AM to 6 PM',
      services: [
        'प्राथमिक आरोग्य सेवा | Primary healthcare',
        'लसीकरण कार्यक्रम | Vaccination programs',
        'रोग नियंत्रण | Disease control',
        'स्वच्छता निरीक्षण | Sanitation inspection',
        'आरोग्य शिक्षण | Health education'
      ]
    },
    'building_planning': {
      name: 'इमारत आणि नगररचना विभाग | Building & Town Planning Department',
      contact: '020-27475205',
      email: 'planning@pcmcindia.gov.in',
      timings: 'सकाळी 10 ते संध्याकाळी 5:30 | 10 AM to 5:30 PM',
      services: [
        'इमारत परवानगी | Building permissions',
        'नकाशा मंजुरी | Plan approvals',
        'विकास नियंत्रण | Development control',
        'नगर नियोजन | Town planning',
        'अतिक्रमण काढणे | Encroachment removal'
      ]
    },
    'property_tax': {
      name: 'मालमत्ता कर विभाग | Property Tax Department',
      contact: '020-27475206',
      email: 'tax@pcmcindia.gov.in',
      timings: 'सकाळी 10 ते संध्याकाळी 5:30 | 10 AM to 5:30 PM',
      services: [
        'मालमत्ता कर मूल्यांकन | Property tax assessment',
        'कर भरणा | Tax payments',
        'कर सूट | Tax exemptions',
        'ऑनलाइन पेमेंट | Online payments',
        'मालमत्ता नोंदणी | Property registration'
      ]
    }
  };

  return departments[department] || null;
}

/**
 * Get service information
 */
function getServiceInfo(service) {
  const services = {
    'birth_certificate': {
      name: 'जन्म प्रमाणपत्र | Birth Certificate',
      description: 'नवजात बाळाचे जन्म प्रमाणपत्र | Birth certificate for newborn',
      department: 'आरोग्य विभाग | Health Department',
      fee: '₹50',
      documents: [
        'हॉस्पिटल जन्म प्रमाणपत्र | Hospital birth certificate',
        'पालकांची ओळखपत्रे | Parent ID proofs',
        'पत्ता पुरावा | Address proof',
        'आधार कार्ड | Aadhaar Card'
      ],
      processingTime: '7 दिवस | 7 days'
    },
    'death_certificate': {
      name: 'मृत्यू प्रमाणपत्र | Death Certificate',
      description: 'व्यक्तीचे मृत्यू प्रमाणपत्र | Death certificate for individual',
      department: 'आरोग्य विभाग | Health Department',
      fee: '₹50',
      documents: [
        'वैद्यकीय प्रमाणपत्र | Medical certificate',
        'कुटुंब सदस्याची ओळखपत्र | Family member ID proof',
        'पत्ता पुरावा | Address proof'
      ],
      processingTime: '3 दिवस | 3 days'
    },
    'trade_license': {
      name: 'व्यापार परवाना | Trade License',
      description: 'व्यवसायासाठी परवाना | License for business',
      department: 'सामान्य प्रशासन | General Administration',
      fee: '₹500 - ₹5000',
      documents: [
        'दुकान करार | Shop agreement',
        'ओळखपत्र | ID proof',
        'NOC आवश्यक असल्यास | NOC if required',
        'पत्ता पुरावा | Address proof'
      ],
      processingTime: '15 दिवस | 15 days'
    },
    'water_connection': {
      name: 'पाणी कनेक्शन | Water Connection',
      description: 'नवीन पाणी कनेक्शनसाठी अर्ज | Application for new water connection',
      department: 'पाणीपुरवठा विभाग | Water Supply Department',
      fee: '₹2000 - ₹10000',
      documents: [
        'मालकी हक्काचे कागदपत्र | Ownership documents',
        'ओळखपत्र | ID proof',
        'पत्ता पुरावा | Address proof',
        'साइट प्लॅन | Site plan'
      ],
      processingTime: '21 दिवस | 21 days'
    },
    'building_permit': {
      name: 'इमारत परवानगी | Building Permit',
      description: 'बांधकामासाठी परवानगी | Permission for construction',
      department: 'इमारत आणि नगररचना विभाग | Building & Planning Department',
      fee: '₹5000 - ₹50000',
      documents: [
        'नकाशे (7 प्रती) | Plans (7 copies)',
        'जमीन कागदपत्र | Land documents',
        'NOC गरजेनुसार | NOC as required',
        'सर्व्हे नंबर | Survey number'
      ],
      processingTime: '45 दिवस | 45 days'
    },
    'marriage_certificate': {
      name: 'विवाह नोंदणी | Marriage Registration',
      description: 'विवाह नोंदणी प्रमाणपत्र | Marriage registration certificate',
      department: 'सामान्य प्रशासन | General Administration',
      fee: '₹100',
      documents: [
        'विवाह निमंत्रण पत्र | Wedding invitation',
        'दोन्ही पक्षांची ओळखपत्रे | ID proofs of both parties',
        'वय पुरावा | Age proof',
        '2 साक्षीदार | 2 witnesses'
      ],
      processingTime: '10 दिवस | 10 days'
    }
  };

  return services[service] || null;
}

/**
 * Get estimated resolution time based on department and priority
 */
function getEstimatedResolutionTime(department, priority) {
  const baseTimes = {
    'Water Supply': 24,
    'Waste Management': 48,
    'Roads & Infrastructure': 72,
    'Health & Sanitation': 24,
    'Building & Planning': 168, // 1 week
    'Electricity': 12,
    'Parks & Recreation': 48,
    'Traffic & Transport': 24,
    'Property Tax': 72,
    'General Administration': 48
  };

  const priorityMultipliers = {
    'emergency': 0.25,
    'high': 0.5,
    'medium': 1.0,
    'low': 1.5
  };

  const baseTime = baseTimes[department] || 48;
  const multiplier = priorityMultipliers[priority] || 1.0;
  
  return Math.ceil(baseTime * multiplier);
}

/**
 * Update message status in database (optional feature)
 */
async function updateMessageStatus(messageId, status, timestamp) {
  try {
    // Optional: Store message delivery status for analytics
    logger.debug('Message status tracking', {
      messageId,
      status,
      timestamp: new Date(parseInt(timestamp) * 1000).toISOString()
    });
    
    // Example implementation for message status tracking:
    /*
    const statusRef = admin.firestore().collection('message_status').doc(messageId);
    await statusRef.set(sanitizeFirestoreData({
      messageId,
      status,
      timestamp: new Date(parseInt(timestamp) * 1000),
      updatedAt: admin.firestore.FieldValue.serverTimestamp()
    }), { merge: true });
    */
    
  } catch (error) {
    logger.warning('Error updating message status', {
      error: error.message,
      messageId,
      status
    });
  }
}

/**
 * Send typing indicator (if supported by WhatsApp Business API)
 */
async function sendTypingIndicator(phoneNumber) {
  try {
    // Note: Typing indicators may not be supported in all WhatsApp Business API versions
    logger.debug('Sending typing indicator', {
      phoneNumber: phoneNumber.replace(/^91/, 'XXX-XXX-')
    });
    
    // Implementation would depend on WhatsApp Business API capabilities
    // This is a placeholder for future enhancement
    
  } catch (error) {
    logger.debug('Typing indicator not supported or failed', {
      error: error.message
    });
  }
}

/**
 * Handle system maintenance mode
 */
async function handleMaintenanceMode(phoneNumber) {
  try {
    const maintenanceMessage = `🔧 सिस्टम मेंटेनन्स | System Maintenance\n\nसध्या आमची सेवा मेंटेनन्समध्ये आहे. कृपया थोड्या वेळाने पुन्हा प्रयत्न करा.\n\nअत्यावश्यक कामासाठी: 020-27475000\n\nOur service is currently under maintenance. Please try again later.\n\nFor emergency: 020-27475000`;

    await sendTextMessage(phoneNumber, maintenanceMessage);
    
    logger.warning('Maintenance mode response sent', {
      phoneNumber: phoneNumber.replace(/^91/, 'XXX-XXX-')
    });
    
  } catch (error) {
    logger.critical('Error sending maintenance mode message', {
      error: error.message,
      phoneNumber: phoneNumber.replace(/^91/, 'XXX-XXX-')
    });
  }
}

/**
 * Handle rate limiting for users
 */
async function handleRateLimit(phoneNumber, messageType) {
  try {
    const rateLimitMessage = `⚠️ दर मर्यादा | Rate Limit\n\nतुम्ही खूप जास्त संदेश पाठवले आहेत. कृपया 15 मिनिटांनी पुन्हा प्रयत्न करा.\n\nYou've sent too many messages. Please try again in 15 minutes.\n\nअत्यावश्यक: 020-27475000`;

    await sendTextMessage(phoneNumber, rateLimitMessage);
    
    logger.warning('Rate limit response sent', {
      phoneNumber: phoneNumber.replace(/^91/, 'XXX-XXX-'),
      messageType
    });
    
  } catch (error) {
    logger.critical('Error sending rate limit message', {
      error: error.message,
      phoneNumber: phoneNumber.replace(/^91/, 'XXX-XXX-')
    });
  }
}

/**
 * Log performance metrics
 */
function logPerformanceMetrics(operation, startTime, additionalData = {}) {
  const endTime = Date.now();
  const duration = endTime - startTime;
  
  logger.debug(`⚡ Performance: ${operation}`, {
    operation,
    duration: `${duration}ms`,
    timestamp: new Date().toISOString(),
    ...additionalData
  });
  
  // Log slow operations
  if (duration > 5000) { // 5 seconds
    logger.warning(`🐌 Slow operation detected: ${operation}`, {
      operation,
      duration: `${duration}ms`,
      ...additionalData
    });
  }
  
  return duration;
}

/**
 * Clean up temporary resources
 */
function cleanupTempResources(tempFiles = []) {
  tempFiles.forEach(filePath => {
    try {
      if (fs.existsSync(filePath)) {
        fs.unlinkSync(filePath);
        logger.debug('🗑️ Temporary file cleaned up', { filePath });
      }
    } catch (error) {
      logger.warning('Failed to cleanup temporary file', {
        filePath,
        error: error.message
      });
    }
  });
}

/**
 * Generate comprehensive error report
 */
function generateErrorReport(error, context = {}) {
  return {
    timestamp: new Date().toISOString(),
    error: {
      message: error.message,
      stack: error.stack,
      name: error.name
    },
    context,
    system: {
      nodeVersion: process.version,
      platform: process.platform,
      memory: process.memoryUsage(),
      uptime: process.uptime()
    },
    environment: process.env.NODE_ENV || 'development'
  };
}

/**
 * Handle webhook verification for development/testing
 */
function handleWebhookVerification(req, res) {
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];

  logger.webhook('🔐 Webhook verification request', {
    mode,
    tokenProvided: !!token,
    challengeProvided: !!challenge,
    ip: req.ip,
    userAgent: req.get('User-Agent')
  });

  if (mode === 'subscribe' && token === process.env.VERIFY_TOKEN) {
    logger.success('✅ Webhook verification successful');
    return res.status(200).send(challenge);
  } else {
    logger.warning('❌ Webhook verification failed', {
      mode,
      tokenMatch: token === process.env.VERIFY_TOKEN,
      expectedToken: process.env.VERIFY_TOKEN ? 'configured' : 'missing'
    });
    return res.sendStatus(403);
  }
}

/**
 * Emergency fallback handler
 */
async function handleEmergencyFallback(phoneNumber, error) {
  try {
    const emergencyMessage = `🚨 आपातकालीन सेवा | Emergency Service\n\nसिस्टममध्ये तांत्रिक समस्या आली आहे.\n\nतातडीच्या मदतीसाठी:\n📞 020-27475000 (PCMC Control Room)\n📞 100 (Police)\n📞 101 (Fire)\n📞 108 (Ambulance)\n\nSystem technical issue occurred.\n\nFor immediate help:\n📞 020-27475000 (PCMC Control Room)`;

    await sendTextMessage(phoneNumber, emergencyMessage);
    
    logger.critical('Emergency fallback message sent', {
      phoneNumber: phoneNumber.replace(/^91/, 'XXX-XXX-'),
      originalError: error.message
    });
    
  } catch (fallbackError) {
    logger.critical('Emergency fallback also failed', {
      phoneNumber: phoneNumber.replace(/^91/, 'XXX-XXX-'),
      originalError: error.message,
      fallbackError: fallbackError.message
    });
  }
}

/**
 * Download audio file from WhatsApp media URL
 */


// Export all functions
module.exports = {
  handleWebhook,
  handleWebhookVerification,
  processIncomingMessage,
  handleTextMessage,
  handleAudioMessage,
  handleImageMessage,
  handleLocationMessage,
  handleInteractiveMessage,
  handleDocumentMessage,
  handleVideoMessage,
  handleStickerMessage,
  handleContactMessage,
  sendUnsupportedMessageResponse,
  handleComplaintFlow,
  handleGeneralConversation,
  handleQueryFlow,
  handleGreetingFlow,
  handleSmallTalkFlow,
  handleComplaintConfirmation,
  handleComplaintCancellation,
  handleDepartmentSelection,
  handleLocationSharingRequest,
  handleListSelection,
  handleServiceSelection,
  processMessageStatus,
  
  // Utility functions
  getPendingComplaintForUser,
  getDraftComplaint,
  getAreaSpecificInfo,
  getPriorityEmoji,
  getDepartmentInfo,
  getServiceInfo,
  getEstimatedResolutionTime,
  updateMessageStatus,
  sendTypingIndicator,
  handleMaintenanceMode,
  handleRateLimit,
  logPerformanceMetrics,
  cleanupTempResources,
  generateErrorReport,
  handleEmergencyFallback,
  downloadAudioFile
};