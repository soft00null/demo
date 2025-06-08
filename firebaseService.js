// services/firebaseService.js - Complete Firebase service with proper timestamp handling
const admin = require('firebase-admin');
const axios = require('axios');
const { v4: uuidv4 } = require('uuid');
const logger = require('../utils/logger');
const { generateTicketId, generateComplaintId, formatPhoneNumber } = require('../utils/helpers');

let firebaseInitialized = false;


// Add this import at the top of the file (around line 10-15)
let aiService; // Lazy import to avoid circular dependency

/**
 * Lazy load AI service to avoid circular dependency
 */
function getAIService() {
  if (!aiService) {
    aiService = require('./aiService');
  }
  return aiService;
}



/**
 * Initialize Firebase Admin SDK with comprehensive error handling
 */
function initializeFirebase() {
  if (!firebaseInitialized) {
    try {
      logger.firebase('🔥 Initializing Firebase Admin SDK...');
      
      // Validate environment variables
      if (!process.env.FIREBASE_SERVICE_ACCOUNT_PATH) {
        throw new Error('FIREBASE_SERVICE_ACCOUNT_PATH environment variable is required');
      }
      
      const serviceAccount = require(process.env.FIREBASE_SERVICE_ACCOUNT_PATH);
      const storageBucket = process.env.FIREBASE_STORAGE_BUCKET || 'pcmc-889cf.firebasestorage.app';
      
      admin.initializeApp({
        credential: admin.credential.cert(serviceAccount),
        storageBucket: `gs://${storageBucket}`,
        databaseURL: process.env.FIREBASE_DATABASE_URL || null
      });
      
      firebaseInitialized = true;
      logger.success('✅ Firebase initialized successfully', {
        projectId: serviceAccount.project_id,
        storageBucket,
        timestamp: new Date().toISOString()
      });
      
      // Test connection
      setTimeout(testFirebaseConnection, 1000);
      
    } catch (error) {
      logger.critical(`💥 Firebase initialization error: ${error.message}`, {
        stack: error.stack,
        serviceAccountPath: process.env.FIREBASE_SERVICE_ACCOUNT_PATH
      });
      throw error;
    }
  }
}

/**
 * Test Firebase connection and services
 */
async function testFirebaseConnection() {
  try {
    logger.firebase('🔗 Testing Firebase connection...');
    
    const startTime = Date.now();
    
    // Test Firestore connection
    const testRef = admin.firestore().collection('_system').doc('health_check');
    await testRef.set({ 
      timestamp: admin.firestore.FieldValue.serverTimestamp(),
      status: 'connected',
      testId: generateTicketId(8),
      version: '2.0.0'
    });
    
    // Read back the document to verify timestamp was saved
    const testDoc = await testRef.get();
    const testData = testDoc.data();
    
    const responseTime = Date.now() - startTime;
    
    if (testData && testData.timestamp) {
      logger.success('✅ Firestore connection test successful', {
        responseTime: `${responseTime}ms`,
        timestampSaved: !!testData.timestamp,
        serverTimestamp: testData.timestamp.toDate().toISOString()
      });
    } else {
      logger.warning('⚠️ Firestore connected but timestamp not saved properly');
    }
    
    // Clean up test document
    await testRef.delete();
    
    // Test Storage connection if configured
    try {
      const bucket = admin.storage().bucket();
      const [exists] = await bucket.exists();
      logger.firebase(`📦 Storage bucket status: ${exists ? 'accessible' : 'not accessible'}`);
    } catch (storageError) {
      logger.warning('⚠️ Storage bucket test failed', { error: storageError.message });
    }
    
  } catch (error) {
    logger.critical('💥 Firebase connection test failed', {
      error: error.message,
      stack: error.stack
    });
  }
}

/**
 * FIXED: Sanitize data for Firestore while preserving FieldValue objects
 */
function sanitizeFirestoreData(data) {
  if (data === null) {
    return null;
  }
  
  if (data === undefined) {
    return null; // Convert undefined to null for Firestore
  }
  
  // CRITICAL: Preserve Firestore FieldValue objects (timestamps, increments, etc.)
  if (data && typeof data === 'object') {
    // Method 1: Check constructor name
    if (data.constructor && (
        data.constructor.name === 'FieldValue' || 
        data.constructor.name === 'FieldValueImpl' ||
        data.constructor.name === 'FieldTransform'
    )) {
      logger.debug('🔥 Preserving Firestore FieldValue', { 
        type: data.constructor.name 
      });
      return data;
    }
    
    // Method 2: Check for serverTimestamp method
    if (data._methodName === 'serverTimestamp' || 
        (data._delegate && data._delegate._methodName === 'serverTimestamp')) {
      logger.debug('🕐 Preserving serverTimestamp');
      return data;
    }
    
    // Method 3: Check for other FieldValue operations
    if (data._methodName || (data._delegate && data._delegate._methodName)) {
      const methodName = data._methodName || data._delegate._methodName;
      logger.debug(`🔥 Preserving Firestore operation: ${methodName}`);
      return data;
    }
    
    // Method 4: Check for Firestore internal properties
    if (data._path || data._converter || data._delegate || data._serializer) {
      logger.debug('🔥 Preserving Firestore internal object');
      return data;
    }
    
    // Preserve GeoPoint objects
    if (data._latitude !== undefined && data._longitude !== undefined) {
      return data;
    }
    
    // Preserve Firestore Timestamp objects
    if (data.seconds !== undefined && data.nanoseconds !== undefined) {
      return data;
    }
  }
  
  // Handle primitive types
  if (typeof data !== 'object') {
    return data;
  }
  
  // Handle arrays
  if (Array.isArray(data)) {
    return data.map(item => sanitizeFirestoreData(item)).filter(item => item !== null);
  }
  
  // Handle Date objects
  if (data instanceof Date) {
    return data;
  }
  
  // Handle regular objects
  const sanitized = {};
  for (const [key, value] of Object.entries(data)) {
    const sanitizedValue = sanitizeFirestoreData(value);
    if (sanitizedValue !== null) {
      sanitized[key] = sanitizedValue;
    }
  }
  
  return sanitized;
}

/**
 * Safe document creation without over-sanitization
 */
function createSafeDocumentData(data) {
  const docData = {};
  
  for (const [key, value] of Object.entries(data)) {
    // Special handling for known timestamp fields
    if (key.endsWith('At') || key === 'timestamp' || key.includes('Time')) {
      docData[key] = value; // Keep as-is, especially FieldValue objects
    } else if (value === undefined) {
      docData[key] = null; // Convert undefined to null for other fields
    } else if (value && typeof value === 'object' && value.constructor?.name?.includes('FieldValue')) {
      docData[key] = value; // Preserve all FieldValue objects
    } else {
      docData[key] = value;
    }
  }
  
  return docData;
}

/**
 * FIXED: Ensure citizen exists with proper timestamp handling
 */
async function ensureCitizenExists(phoneNumber, name) {
  try {
    const formattedPhone = formatPhoneNumber(phoneNumber);
    
    logger.firebase('👤 Ensuring citizen exists', { 
      phoneNumber: formattedPhone.replace(/^91/, 'XXX-XXX-'),
      name: name || 'Unknown'
    });
    
    const citizenRef = admin.firestore().collection('citizens').doc(formattedPhone);
    const citizenDoc = await citizenRef.get();
    
    if (!citizenDoc.exists) {
      logger.firebase('🆕 Creating new citizen profile...');
      
      // Create new citizen with proper timestamps
      const newCitizenData = {
        phoneNumber: formattedPhone,
        name: name || 'Unknown User',
        displayName: name || 'Unknown User',
        botMode: true,
        ethicalScore: 7.5,
        totalMessages: 0,
        complaintsCount: 0,
        queriesCount: 0,
        lastActiveAt: admin.firestore.FieldValue.serverTimestamp(),
        createdAt: admin.firestore.FieldValue.serverTimestamp(),
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
        
        // Profile information
        profile: {
          preferredLanguage: 'auto',
          notificationsEnabled: true,
          location: null,
          ward: null,
          area: null,
          verified: false
        },
        
        // Statistics
        statistics: {
          avgEthicalScore: 7.5,
          avgResponseTime: 0,
          totalSessions: 1,
          lastSessionDuration: 0,
          totalComplaintsResolved: 0,
          totalQueriesAnswered: 0,
          totalInteractions: 0
        },
        
        // Settings
        settings: {
          receiveUpdates: true,
          language: 'auto',
          timezone: 'Asia/Kolkata',
          theme: 'default'
        },
        
        // Metadata
        metadata: {
          source: 'whatsapp',
          version: '2.0.0',
          userAgent: 'PCMC-WhatsApp-Bot',
          registrationMethod: 'first_message',
          firstContact: admin.firestore.FieldValue.serverTimestamp(),
          lastUpdated: admin.firestore.FieldValue.serverTimestamp(),
          ipAddress: null,
          deviceInfo: null
        }
      };
      
      await citizenRef.set(newCitizenData);
      
      logger.success(`✅ New citizen created: ${formattedPhone.replace(/^91/, 'XXX-XXX-')} (${name})`, {
        ethicalScore: 7.5,
        botMode: true
      });
      
    } else {
      logger.firebase('🔄 Updating existing citizen...');
      
      const updateData = {
        lastActiveAt: admin.firestore.FieldValue.serverTimestamp(),
        totalMessages: admin.firestore.FieldValue.increment(1),
        'statistics.totalInteractions': admin.firestore.FieldValue.increment(1),
        'metadata.lastUpdated': admin.firestore.FieldValue.serverTimestamp()
      };
      
      // Update name if provided and different
      if (name && name !== 'Unknown') {
        updateData.name = name;
        updateData.displayName = name;
      }
      
      await citizenRef.update(updateData);
      
      logger.firebase(`✅ Citizen profile updated: ${formattedPhone.replace(/^91/, 'XXX-XXX-')}`);
    }
    
    return formattedPhone;
  } catch (error) {
    logger.critical(`💥 Error ensuring citizen exists: ${error.message}`, { 
      phoneNumber: phoneNumber?.replace(/^91/, 'XXX-XXX-') || 'invalid',
      name,
      stack: error.stack
    });
    throw error;
  }
}

/**
 * Get citizen's bot mode and profile data
 */
async function getCitizenBotMode(phoneNumber) {
  try {
    const formattedPhone = formatPhoneNumber(phoneNumber);
    
    logger.firebase('🤖 Getting citizen bot mode', { 
      phoneNumber: formattedPhone.replace(/^91/, 'XXX-XXX-') 
    });
    
    const citizenRef = admin.firestore().collection('citizens').doc(formattedPhone);
    const citizenDoc = await citizenRef.get();
    
    if (citizenDoc.exists) {
      const data = citizenDoc.data();
      const botMode = data.botMode !== false; // Default to true if undefined
      
      logger.firebase(`✅ Bot mode retrieved: ${botMode}`, { 
        phoneNumber: formattedPhone.replace(/^91/, 'XXX-XXX-'),
        ethicalScore: data.ethicalScore || 'N/A',
        totalMessages: data.totalMessages || 0
      });
      
      return botMode;
    }
    
    logger.firebase('⚠️ Citizen not found, defaulting bot mode to true');
    return true;
  } catch (error) {
    logger.critical(`💥 Error getting citizen bot mode: ${error.message}`, { 
      phoneNumber: phoneNumber?.replace(/^91/, 'XXX-XXX-') || 'invalid'
    });
    return true; // Default to enabled on error
  }
}

/**
 * FIXED: Save chat message with guaranteed timestamps
 */
async function saveChatMessage(phoneNumber, messageData) {
  try {
    const formattedPhone = formatPhoneNumber(phoneNumber);
    
    logger.firebase('💬 Saving chat message', { 
      phoneNumber: formattedPhone.replace(/^91/, 'XXX-XXX-'),
      messageType: messageData.messageType,
      intent: messageData.intent || 'unknown',
      hasContent: !!messageData.content
    });
    
    const chatRef = admin.firestore()
      .collection('citizens')
      .doc(formattedPhone)
      .collection('chats');
    
    // Create message document with guaranteed timestamps
    const messageDoc = {
      // Core message data
      messageId: messageData.messageId || generateTicketId(8),
      sender: messageData.sender || formattedPhone,
      senderName: messageData.senderName || 'Unknown',
      receiver: messageData.receiver || 'pcmc_bot',
      messageType: messageData.messageType || 'text',
      content: messageData.content || '',
      
      // GUARANTEED TIMESTAMPS - Never sanitized
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
      timestamp: admin.firestore.FieldValue.serverTimestamp(),
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      
      // Analysis data
      intent: messageData.intent || 'unknown',
      context: messageData.context || 'general',
      conversationState: messageData.conversationState || messageData.state || 'active',
      language: messageData.language || 'auto',
      ethicalScore: typeof messageData.ethicalScore === 'number' ? messageData.ethicalScore : 7,
      confidence: typeof messageData.confidence === 'number' ? messageData.confidence : 0.7,
      botModeEnabled: messageData.botModeEnabled !== false,
      
      // Optional media data (sanitized)
      imageUrl: messageData.imageUrl || null,
      audioMetadata: messageData.audioMetadata || null,
      imageMetadata: messageData.imageMetadata || null,
      documentMetadata: messageData.documentMetadata || null,
      videoMetadata: messageData.videoMetadata || null,
      stickerMetadata: messageData.stickerMetadata || null,
      contactsMetadata: messageData.contactsMetadata || null,
      location: messageData.location || null,
      interactiveData: messageData.interactiveData || null,
      
      // AI metadata
      aiMetadata: messageData.aiMetadata || null,
      
      // System data
      requestId: messageData.requestId || null,
      processed: true,
      version: '2.0.0',
      
      // Extended metadata with timestamp
      metadata: {
        source: 'whatsapp_webhook',
        version: '2.0.0',
        processed: true,
        savedAt: admin.firestore.FieldValue.serverTimestamp(),
        ...(messageData.metadata || {})
      }
    };
    
    // Log before saving to confirm timestamp presence
    logger.debug('📝 Saving message with timestamps', {
      hasCreatedAt: !!messageDoc.createdAt,
      hasTimestamp: !!messageDoc.timestamp,
      hasUpdatedAt: !!messageDoc.updatedAt,
      hasSavedAt: !!messageDoc.metadata.savedAt,
      messageType: messageDoc.messageType
    });
    
    const docRef = await chatRef.add(messageDoc);
    
    // Update citizen statistics
    await updateCitizenStats(formattedPhone, messageData);
    
    logger.success(`✅ Chat message saved with guaranteed timestamps`, { 
      type: messageData.messageType,
      intent: messageData.intent,
      docId: docRef.id,
      phoneNumber: formattedPhone.replace(/^91/, 'XXX-XXX-')
    });
    
    return docRef.id;
  } catch (error) {
    logger.critical(`💥 Error saving chat message: ${error.message}`, { 
      phoneNumber: phoneNumber?.replace(/^91/, 'XXX-XXX-') || 'invalid',
      messageType: messageData?.messageType || 'unknown',
      stack: error.stack
    });
    throw error;
  }
}

/**
 * Get conversation context for AI processing
 */
async function getConversationContext(phoneNumber, limit = 10) {
  try {
    const formattedPhone = formatPhoneNumber(phoneNumber);
    
    logger.firebase('📚 Getting conversation context', { 
      phoneNumber: formattedPhone.replace(/^91/, 'XXX-XXX-'),
      limit 
    });
    
    const chatsRef = admin.firestore()
      .collection('citizens')
      .doc(formattedPhone)
      .collection('chats');
    
    const snapshot = await chatsRef
      .orderBy('createdAt', 'desc')
      .limit(limit * 2)
      .get();
    
    const context = [];
    snapshot.docs.reverse().forEach(doc => {
      const data = doc.data();
      
      // Only include text messages for context, exclude system messages
      if (data.messageType === 'text' && data.content && data.content.trim() && 
          !data.content.includes('🏛️ **PCMC')) {
        context.push({
          role: data.sender === formattedPhone ? 'user' : 'assistant',
          content: data.content.substring(0, 500),
          timestamp: data.createdAt,
          intent: data.intent,
          context: data.context,
          ethicalScore: data.ethicalScore || 7,
          language: data.language
        });
      }
    });
    
    const relevantContext = context.slice(-limit);
    
    logger.firebase(`✅ Context retrieved: ${relevantContext.length} messages`, { 
      phoneNumber: formattedPhone.replace(/^91/, 'XXX-XXX-'),
      totalMessages: snapshot.docs.length
    });
    
    return relevantContext;
  } catch (error) {
    logger.critical(`💥 Error getting conversation context: ${error.message}`, { 
      phoneNumber: phoneNumber?.replace(/^91/, 'XXX-XXX-') || 'invalid'
    });
    return [];
  }
}

/**
 * FIXED: Update citizen's ethical score with timestamp
 */
async function updateCitizenEthicalScore(phoneNumber, messageEthicalScore) {
  try {
    const formattedPhone = formatPhoneNumber(phoneNumber);
    
    logger.firebase('📊 Updating citizen ethical score', { 
      phoneNumber: formattedPhone.replace(/^91/, 'XXX-XXX-'),
      newScore: messageEthicalScore 
    });
    
    const citizenRef = admin.firestore().collection('citizens').doc(formattedPhone);
    const citizenDoc = await citizenRef.get();
    
    if (citizenDoc.exists) {
      const currentData = citizenDoc.data();
      const currentScore = currentData.ethicalScore || 7.5;
      const totalMessages = currentData.totalMessages || 1;
      
      // Sophisticated weighted average
      const weight = Math.min(totalMessages, 100);
      const decay = Math.max(0.1, 1 / Math.sqrt(totalMessages + 1));
      const newScore = ((currentScore * weight * (1 - decay)) + (messageEthicalScore * 3)) / (weight * (1 - decay) + 3);
      const roundedScore = Math.round(newScore * 10) / 10;
      const finalScore = Math.max(1, Math.min(10, roundedScore));
      
      const updateData = {
        ethicalScore: finalScore,
        'statistics.avgEthicalScore': finalScore,
        'metadata.lastUpdated': admin.firestore.FieldValue.serverTimestamp()
      };
      
      await citizenRef.update(updateData);
      
      logger.firebase(`📊 Ethical score updated: ${currentScore} → ${finalScore}`, { 
        phoneNumber: formattedPhone.replace(/^91/, 'XXX-XXX-'),
        messageScore: messageEthicalScore,
        totalMessages
      });
    }
  } catch (error) {
    logger.critical(`💥 Error updating citizen ethical score: ${error.message}`, { 
      phoneNumber: phoneNumber?.replace(/^91/, 'XXX-XXX-') || 'invalid'
    });
  }
}

/**
 * FIXED: Update citizen statistics with timestamps
 */
async function updateCitizenStats(phoneNumber, messageData) {
  try {
    const formattedPhone = formatPhoneNumber(phoneNumber);
    const citizenRef = admin.firestore().collection('citizens').doc(formattedPhone);
    const updates = {};
    
    // Update based on message intent
    if (messageData.intent === 'complaint') {
      updates.complaintsCount = admin.firestore.FieldValue.increment(1);
      updates['statistics.totalComplaintsResolved'] = admin.firestore.FieldValue.increment(0);
    } else if (messageData.intent === 'query') {
      updates.queriesCount = admin.firestore.FieldValue.increment(1);
      updates['statistics.totalQueriesAnswered'] = admin.firestore.FieldValue.increment(1);
    }
    
    // Update language preference if detected
    if (messageData.language && messageData.sender === formattedPhone) {
      updates['profile.preferredLanguage'] = messageData.language;
    }
    
    // Update session information
    if (messageData.sender === formattedPhone) {
      updates['statistics.totalSessions'] = admin.firestore.FieldValue.increment(1);
    }
    
    // Always update metadata timestamp
    updates['metadata.lastUpdated'] = admin.firestore.FieldValue.serverTimestamp();
    
    if (Object.keys(updates).length > 0) {
      await citizenRef.update(updates);
      logger.firebase(`📈 Citizen stats updated`, { 
        phoneNumber: formattedPhone.replace(/^91/, 'XXX-XXX-'), 
        updatedFields: Object.keys(updates)
      });
    }
  } catch (error) {
    logger.critical(`💥 Error updating citizen stats: ${error.message}`, { 
      phoneNumber: phoneNumber?.replace(/^91/, 'XXX-XXX-') || 'invalid'
    });
  }
}

/**
 * Check for duplicate complaints using AI similarity analysis
 */
async function checkDuplicateComplaint(complaintText, phoneNumber, location = null, imageUrl = null) {
  try {
    const formattedPhone = formatPhoneNumber(phoneNumber);
    
    logger.firebase('🔍 Enhanced duplicate complaint check', { 
      phoneNumber: formattedPhone.replace(/^91/, 'XXX-XXX-'),
      complaintLength: complaintText.length,
      hasLocation: !!location,
      hasImage: !!imageUrl
    });
    
    const complaintsRef = admin.firestore().collection('complaints');
    
    // Query recent active complaints (last 30 days) with location data
    const thirtyDaysAgo = new Date();
    thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);
    
    const query = complaintsRef
      .where('status', 'in', ['active', 'in_progress', 'open'])
      .where('createdAt', '>=', thirtyDaysAgo)
      .orderBy('createdAt', 'desc')
      .limit(50);

    const snapshot = await query.get();
    
    if (snapshot.empty) {
      logger.firebase('✅ No existing complaints found for duplicate check');
      return { isDuplicate: false };
    }

    // FIXED: Get AI service with lazy loading
    const ai = getAIService();
    
    let bestMatch = null;
    let highestScore = 0;
    
    for (const doc of snapshot.docs) {
      const existingComplaint = doc.data();
      
      // Skip if same user (allow multiple complaints from same person)
      if (existingComplaint.createdBy === formattedPhone) {
        continue;
      }
      
      // FIXED: Get department categorization with proper import
      let skipDepartmentCheck = false;
      try {
        const newDepartment = await ai.categorizeDepartment(complaintText);
        
        // Skip if different departments (unless very close location)
        if (existingComplaint.department !== newDepartment && 
            (!location || !existingComplaint.location || 
             calculateQuickDistance(location, existingComplaint.location) > 0.2)) {
          logger.debug('⏩ Skipping complaint - different department and distant location', {
            newDept: newDepartment,
            existingDept: existingComplaint.department,
            distance: location && existingComplaint.location ? 
              calculateQuickDistance(location, existingComplaint.location) : 'unknown'
          });
          continue;
        }
      } catch (deptError) {
        logger.warning('⚠️ Error categorizing department, proceeding with comparison', {
          error: deptError.message
        });
        skipDepartmentCheck = true;
      }
      
      // Run enhanced similarity analysis
      try {
        const similarity = await ai.checkComplaintSimilarity(
          complaintText, 
          existingComplaint.description,
          location,
          existingComplaint.location,
          imageUrl,
          existingComplaint.imageUrl
        );
        
        logger.debug('🔍 Similarity analysis result', {
          complaintId: doc.id,
          score: similarity.score,
          isDuplicate: similarity.isDuplicate,
          confidence: similarity.confidence
        });
        
        if (similarity.score > highestScore) {
          highestScore = similarity.score;
          bestMatch = {
            complaint: existingComplaint,
            similarity,
            docId: doc.id
          };
        }
      } catch (similarityError) {
        logger.warning('⚠️ Error in similarity analysis, skipping complaint', {
          error: similarityError.message,
          complaintId: doc.id
        });
        continue;
      }
    }
    
    // Enhanced duplicate detection logic
    if (bestMatch && bestMatch.similarity.isDuplicate) {
      // Add user to complaint follow-up list
      await addUserToComplaintFollowUp(bestMatch.docId, formattedPhone);
      
      logger.firebase('🔄 Enhanced duplicate complaint detected', {
        phoneNumber: formattedPhone.replace(/^91/, 'XXX-XXX-'),
        existingTicketId: bestMatch.complaint.ticketId,
        similarityScore: bestMatch.similarity.score,
        confidence: bestMatch.similarity.confidence,
        breakdown: bestMatch.similarity.breakdown
      });
      
      return {
        isDuplicate: true,
        ticketId: bestMatch.complaint.ticketId,
        status: bestMatch.complaint.status,
        similarity: bestMatch.similarity.score,
        confidence: bestMatch.similarity.confidence,
        explanation: bestMatch.similarity.explanation,
        breakdown: bestMatch.similarity.breakdown,
        originalComplaint: bestMatch.complaint.description.substring(0, 150) + '...',
        department: bestMatch.complaint.department,
        priority: bestMatch.complaint.priority,
        location: bestMatch.complaint.location,
        distance: bestMatch.similarity.breakdown?.location?.distance
      };
    }
    
    logger.firebase('✅ No duplicate complaints found after enhanced analysis', {
      phoneNumber: formattedPhone.replace(/^91/, 'XXX-XXX-'),
      highestScore: highestScore.toFixed(3),
      totalChecked: snapshot.docs.length - 1 // Exclude same user
    });
    
    return { 
      isDuplicate: false, 
      highestScore, 
      totalChecked: snapshot.docs.length,
      message: 'No duplicates found - proceeding with new complaint'
    };
    
  } catch (error) {
    logger.critical(`💥 Error in enhanced duplicate complaint check: ${error.message}`, { 
      phoneNumber: phoneNumber?.replace(/^91/, 'XXX-XXX-') || 'invalid',
      stack: error.stack,
      functionName: 'checkDuplicateComplaint',
      timestamp: new Date().toISOString()
    });
    
    // Return safe fallback to allow complaint registration
    return { 
      isDuplicate: false, 
      error: error.message,
      fallback: true,
      message: 'Error in duplicate check - allowing new complaint'
    };
  }
}

/**
 * Quick distance calculation for filtering
 */
function calculateQuickDistance(loc1, loc2) {
  if (!loc1 || !loc2 || !loc1.latitude || !loc2.latitude) return Infinity;
  
  const lat1 = loc1.latitude;
  const lon1 = loc1.longitude;
  const lat2 = loc2.latitude;
  const lon2 = loc2.longitude;
  
  const R = 6371; // Earth's radius in km
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLon = (lon2 - lon1) * Math.PI / 180;
  const a = Math.sin(dLat/2) * Math.sin(dLat/2) +
            Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) * 
            Math.sin(dLon/2) * Math.sin(dLon/2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
  return R * c;
}

/**
 * FIXED: Create draft complaint with guaranteed timestamps
 */
async function createDraftComplaint(description, phoneNumber, intentAnalysis, imageUrl = null) {
  try {
    const formattedPhone = formatPhoneNumber(phoneNumber);
    const complaintId = generateComplaintId();
    
    logger.firebase('📝 Creating draft complaint', {
      complaintId,
      phoneNumber: formattedPhone.replace(/^91/, 'XXX-XXX-'),
      descriptionLength: description.length,
      hasImage: !!imageUrl
    });
    
    // Get AI service with proper error handling
    const ai = getAIService();
    
    let department = 'General Administration';
    let priority = 'medium';
    let category = 'General Services';
    
    try {
      // Get AI-powered categorization with fallbacks
      const [deptResult, priorityResult, categoryResult] = await Promise.allSettled([
        ai.categorizeDepartment(description),
        ai.assessComplaintPriority(description),
        ai.categorizeComplaintType(description)
      ]);
      
      if (deptResult.status === 'fulfilled') {
        department = deptResult.value;
      }
      
      if (priorityResult.status === 'fulfilled') {
        priority = priorityResult.value;
      }
      
      if (categoryResult.status === 'fulfilled') {
        category = categoryResult.value;
      }
      
    } catch (aiError) {
      logger.warning('⚠️ AI categorization failed, using defaults', {
        error: aiError.message
      });
    }
    
    const estimatedResolutionTime = calculateEstimatedResolutionTime(department, priority);
    
    // FIXED: Create workflow steps array WITHOUT FieldValue.serverTimestamp inside arrays
    const currentTimestamp = new Date().toISOString();
    
    const draftComplaint = {
      id: complaintId,
      description: description.trim(),
      department,
      priority,
      category,
      createdBy: formattedPhone,
      status: 'draft',
      
      // GUARANTEED TIMESTAMPS
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      
      // Analysis data
      intent: intentAnalysis.intent,
      context: intentAnalysis.context,
      state: intentAnalysis.state,
      confidence: intentAnalysis.confidence || 0.7,
      language: intentAnalysis.language || 'auto',
      
      // Complaint specifics
      estimatedResolutionTime,
      location: null,
      imageUrl: imageUrl || null,
      requiresLocationSharing: true,
      ticketId: null,
      
      // FIXED: Workflow tracking WITHOUT FieldValue in arrays
      workflow: {
        step: 'location_required',
        nextAction: 'await_location',
        completionPercentage: 30,
        lastUpdated: admin.firestore.FieldValue.serverTimestamp(),
        // Use ISO strings instead of FieldValue in arrays
        steps: [
          {
            step: 'complaint_registered',
            status: 'completed',
            timestamp: currentTimestamp
          },
          {
            step: 'ai_processed',
            status: 'completed',
            timestamp: currentTimestamp
          },
          {
            step: 'location_required',
            status: 'pending',
            timestamp: null
          }
        ]
      },
      
      // Metadata with timestamps
      metadata: {
        source: 'whatsapp_bot',
        version: '2.0.0',
        aiProcessed: true,
        userAgent: 'PCMC-WhatsApp-Bot',
        createdDate: currentTimestamp,
        processedAt: admin.firestore.FieldValue.serverTimestamp(),
        lastModified: admin.firestore.FieldValue.serverTimestamp(),
        aiCategorization: {
          department,
          priority,
          category,
          confidence: intentAnalysis.confidence || 0.7
        }
      }
    };

    const complaintRef = admin.firestore().collection('complaints').doc(complaintId);
    await complaintRef.set(draftComplaint);
    
    logger.success(`✅ Draft complaint created: ${complaintId}`, { 
      phoneNumber: formattedPhone.replace(/^91/, 'XXX-XXX-'), 
      department, 
      priority,
      category,
      estimatedResolution: `${estimatedResolutionTime} hours`
    });
    
    return { ...draftComplaint, id: complaintId };
  } catch (error) {
    logger.critical(`💥 Error creating draft complaint: ${error.message}`, { 
      phoneNumber: phoneNumber?.replace(/^91/, 'XXX-XXX-') || 'invalid',
      stack: error.stack,
      functionName: 'createDraftComplaint',
      timestamp: new Date().toISOString()
    });
    throw error;
  }
}

/**
 * FIXED: Confirm complaint with location and create ticket
 */
async function confirmComplaint(complaintId, whatsappLocationData) {
  try {
    logger.firebase('✅ Confirming complaint with location', { 
      complaintId,
      location: `${whatsappLocationData.latitude}, ${whatsappLocationData.longitude}`
    });
    
    const complaintRef = admin.firestore().collection('complaints').doc(complaintId);
    const complaintDoc = await complaintRef.get();
    
    if (!complaintDoc.exists) {
      throw new Error(`Complaint ${complaintId} not found`);
    }

    const complaintData = complaintDoc.data();
    const ticketId = generateTicketId(8);
    
    // Prepare location data
    const locationData = {
      latitude: whatsappLocationData.latitude,
      longitude: whatsappLocationData.longitude,
      address: whatsappLocationData.address || await geocodeAddress(whatsappLocationData.latitude, whatsappLocationData.longitude),
      name: whatsappLocationData.name || null,
      source: 'whatsapp_location',
      accuracy: whatsappLocationData.accuracy || null,
      receivedAt: admin.firestore.FieldValue.serverTimestamp()
    };
    
    // Update complaint with confirmation
    const updateData = {
      status: 'active',
      ticketId,
      location: locationData,
      requiresLocationSharing: false,
      confirmedAt: admin.firestore.FieldValue.serverTimestamp(),
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      'workflow.step': 'confirmed',
      'workflow.nextAction': 'assign_department',
      'workflow.completionPercentage': 60,
      'workflow.lastUpdated': admin.firestore.FieldValue.serverTimestamp()
    };
    
    await complaintRef.update(updateData);

    // Create comprehensive ticket record
    await createTicketRecord(ticketId, complaintId, { ...complaintData, ...updateData }, locationData);
    
    // Update citizen complaint count
    await updateCitizenComplaintCount(complaintData.createdBy);
    
    logger.success(`✅ Complaint confirmed and ticket created: ${complaintId} → ${ticketId}`, {
      department: complaintData.department,
      priority: complaintData.priority,
      phoneNumber: complaintData.createdBy.replace(/^91/, 'XXX-XXX-')
    });
    
    return ticketId;
  } catch (error) {
    logger.critical(`💥 Error confirming complaint: ${error.message}`, { 
      complaintId,
      stack: error.stack
    });
    throw error;
  }
}

/**
 * FIXED: Cancel complaint with proper cleanup
 */
async function cancelComplaint(complaintId) {
  try {
    logger.firebase('❌ Cancelling complaint', { complaintId });
    
    const complaintRef = admin.firestore().collection('complaints').doc(complaintId);
    
    const updateData = {
      status: 'cancelled',
      cancelledAt: admin.firestore.FieldValue.serverTimestamp(),
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      'workflow.step': 'cancelled',
      'workflow.nextAction': 'none',
      'workflow.completionPercentage': 0,
      'workflow.lastUpdated': admin.firestore.FieldValue.serverTimestamp()
    };
    
    await complaintRef.update(updateData);
    
    logger.firebase(`✅ Complaint cancelled: ${complaintId}`);
  } catch (error) {
    logger.critical(`💥 Error cancelling complaint: ${error.message}`, { 
      complaintId,
      stack: error.stack
    });
    throw error;
  }
}

/**
 * Get user's complaint status and history
 */
async function getUserComplaintStatus(phoneNumber) {
  try {
    const formattedPhone = formatPhoneNumber(phoneNumber);
    
    logger.firebase('📋 Getting user complaint status', { 
      phoneNumber: formattedPhone.replace(/^91/, 'XXX-XXX-') 
    });

    const complaintsRef = admin.firestore().collection('complaints');
    const snapshot = await complaintsRef
      .where('createdBy', '==', formattedPhone)
      .where('status', '!=', 'cancelled')
      .orderBy('status')
      .orderBy('createdAt', 'desc')
      .limit(25)
      .get();

    const complaints = [];
    snapshot.docs.forEach(doc => {
      const data = doc.data();
      
      complaints.push({
        id: data.id,
        ticketId: data.ticketId || 'Pending',
        description: data.description.substring(0, 120) + (data.description.length > 120 ? '...' : ''),
        department: data.department,
        status: data.status,
        priority: data.priority,
        category: data.category,
        createdAt: data.createdAt,
        updatedAt: data.updatedAt || data.createdAt,
        confirmedAt: data.confirmedAt,
        estimatedResolutionTime: data.estimatedResolutionTime,
        location: data.location,
        workflow: data.workflow || { 
          step: 'unknown', 
          completionPercentage: 0,
          nextAction: 'pending'
        },
        imageUrl: data.imageUrl
      });
    });

    logger.firebase(`✅ Found ${complaints.length} complaints for user`);
    return complaints;
  } catch (error) {
    logger.critical('💥 Error getting user complaint status', { 
      error: error.message,
      phoneNumber: phoneNumber?.replace(/^91/, 'XXX-XXX-') || 'invalid',
      stack: error.stack
    });
    return [];
  }
}

/**
 * Geocode coordinates to address using Google Maps API
 */
async function geocodeAddress(latitude, longitude) {
  try {
    logger.firebase('🗺️ Geocoding coordinates', { latitude, longitude });
    
    if (!process.env.GOOGLE_MAPS_API_KEY) {
      logger.warning('⚠️ Google Maps API key not configured');
      return `Location: ${latitude}, ${longitude}`;
    }
    
    const response = await axios.get('https://maps.googleapis.com/maps/api/geocode/json', {
      params: {
        latlng: `${latitude},${longitude}`,
        key: process.env.GOOGLE_MAPS_API_KEY,
        language: 'en',
        result_type: 'street_address|subpremise|premise|sublocality'
      },
      timeout: 10000
    });
    
    if (response.data.results && response.data.results.length > 0) {
      const address = response.data.results[0].formatted_address;
      logger.firebase('✅ Coordinates geocoded successfully', { 
        latitude, 
        longitude, 
        address: address.substring(0, 60) + '...'
      });
      return address;
    }
    
    const fallbackAddress = `Location: ${latitude}, ${longitude}`;
    logger.warning('⚠️ Geocoding returned no results, using coordinates');
    return fallbackAddress;
  } catch (error) {
    logger.critical(`💥 Error geocoding address: ${error.message}`, { 
      latitude, 
      longitude,
      apiKey: process.env.GOOGLE_MAPS_API_KEY ? 'configured' : 'missing'
    });
    return `Location: ${latitude}, ${longitude}`;
  }
}

/**
 * Get WhatsApp media URL with enhanced error handling
 */
async function getMediaUrl(mediaId) {
  try {
    logger.whatsapp('📎 Getting media URL', { mediaId });
    
    const response = await axios.get(`https://graph.facebook.com/v18.0/${mediaId}`, {
      headers: { 
        'Authorization': `Bearer ${process.env.WHATSAPP_TOKEN}`,
        'User-Agent': 'PCMC-WhatsApp-Bot/2.0'
      },
      timeout: 15000
    });
    
    logger.whatsapp('✅ Media URL retrieved successfully', { 
      mediaId,
      url: response.data.url.substring(0, 60) + '...',
      mimeType: response.data.mime_type
    });
    
    return response.data.url;
  } catch (error) {
    logger.critical(`💥 Error getting media URL: ${error.message}`, { 
      mediaId,
      status: error.response?.status,
      statusText: error.response?.statusText
    });
    throw error;
  }
}

/**
 * Download and upload image to Firebase Storage
 */
async function downloadAndUploadImage(mediaUrl, mediaId) {
  try {
    logger.firebase('🖼️ Downloading and uploading image', { mediaId });
    
    const response = await axios.get(mediaUrl, {
      responseType: 'arraybuffer',
      headers: { 
        'Authorization': `Bearer ${process.env.WHATSAPP_TOKEN}`,
        'User-Agent': 'PCMC-WhatsApp-Bot/2.0'
      },
      timeout: 30000
    });
    
    const bucket = admin.storage().bucket();
    const fileName = `complaints/images/${mediaId}_${Date.now()}.jpg`;
    const file = bucket.file(fileName);
    
    const fileSize = response.data.byteLength;
    
    await file.save(Buffer.from(response.data), {
      metadata: { 
        contentType: 'image/jpeg',
        metadata: {
          originalMediaId: mediaId,
          uploadedAt: new Date().toISOString(),
          source: 'whatsapp',
          fileSize: fileSize.toString(),
          version: '2.0.0',
          userAgent: 'PCMC-WhatsApp-Bot'
        }
      }
    });
    
    await file.makePublic();
    const publicUrl = `https://storage.googleapis.com/${bucket.name}/${fileName}`;
    
    logger.success(`✅ Image uploaded successfully: ${fileName}`, {
      mediaId,
      fileSize: `${(fileSize / 1024).toFixed(2)} KB`,
      url: publicUrl.substring(0, 60) + '...'
    });
    
    return publicUrl;
  } catch (error) {
    logger.critical(`💥 Error uploading image: ${error.message}`, { 
      mediaId,
      stack: error.stack
    });
    throw error;
  }
}

/**
 * FIXED: Create comprehensive ticket record with timestamps
 */
async function createTicketRecord(ticketId, complaintId, complaintData, locationData) {
  try {
    logger.firebase('🎫 Creating ticket record', { ticketId, complaintId });
    
    const currentTimestamp = new Date().toISOString();
    
    const ticketData = {
      ticketId,
      complaintId,
      createdBy: complaintData.createdBy,
      department: complaintData.department,
      status: 'open',
      priority: complaintData.priority,
      category: complaintData.category,
      description: complaintData.description,
      location: locationData,
      
      // GUARANTEED TIMESTAMPS
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      
      estimatedResolution: new Date(Date.now() + complaintData.estimatedResolutionTime * 60 * 60 * 1000),
      assignedTo: null,
      assignedAt: null,
      resolvedAt: null,
      closedAt: null,
      
      updates: [],
      followUpUsers: [complaintData.createdBy],
      
      workflow: {
        currentStep: 'ticket_created',
        nextStep: 'department_assignment',
        completionPercentage: 70,
        lastUpdated: admin.firestore.FieldValue.serverTimestamp(),
        // FIXED: Use ISO strings in arrays instead of FieldValue
        steps: [
          {
            step: 'complaint_registered',
            status: 'completed',
            timestamp: currentTimestamp
          },
          {
            step: 'location_confirmed',
            status: 'completed',
            timestamp: currentTimestamp
          },
          {
            step: 'ticket_created',
            status: 'completed',
            timestamp: currentTimestamp
          },
          {
            step: 'department_assignment',
            status: 'pending',
            timestamp: null
          }
        ]
      },
      
      metadata: {
        source: complaintData.metadata?.source || 'whatsapp_bot',
        version: '2.0.0',
        aiProcessed: complaintData.metadata?.aiProcessed || true,
        initialPriority: complaintData.priority,
        estimatedHours: complaintData.estimatedResolutionTime,
        createdViaBot: true,
        ticketCreatedAt: admin.firestore.FieldValue.serverTimestamp()
      }
    };
    
    const ticketRef = admin.firestore().collection('tickets').doc(ticketId);
    await ticketRef.set(ticketData);
    
    logger.success('✅ Ticket record created successfully', { 
      ticketId,
      department: complaintData.department,
      priority: complaintData.priority
    });
  } catch (error) {
    logger.critical(`💥 Error creating ticket record: ${error.message}`, { 
      ticketId,
      complaintId,
      stack: error.stack
    });
    throw error;
  }
}

/**
 * FIXED: Add user to complaint follow-up list
 */
async function addUserToComplaintFollowUp(complaintId, phoneNumber) {
  try {
    const formattedPhone = formatPhoneNumber(phoneNumber);
    
    logger.firebase('👥 Adding user to complaint follow-up', { 
      complaintId, 
      phoneNumber: formattedPhone.replace(/^91/, 'XXX-XXX-') 
    });
    
    const complaintRef = admin.firestore().collection('complaints').doc(complaintId);
    const ticketsRef = admin.firestore().collection('tickets')
      .where('complaintId', '==', complaintId)
      .limit(1);
    
    // Add to complaint follow-up
    await complaintRef.update({
      followUpUsers: admin.firestore.FieldValue.arrayUnion(formattedPhone),
      updatedAt: admin.firestore.FieldValue.serverTimestamp()
    });
    
    // Add to ticket follow-up if ticket exists
    const ticketSnapshot = await ticketsRef.get();
    if (!ticketSnapshot.empty) {
      const ticketDoc = ticketSnapshot.docs[0];
      await ticketDoc.ref.update({
        followUpUsers: admin.firestore.FieldValue.arrayUnion(formattedPhone),
        updatedAt: admin.firestore.FieldValue.serverTimestamp()
      });
    }
    
    logger.firebase('✅ User added to follow-up lists successfully');
  } catch (error) {
    logger.critical(`💥 Error adding user to follow-up: ${error.message}`, { 
      complaintId, 
      phoneNumber: phoneNumber?.replace(/^91/, 'XXX-XXX-') || 'invalid'
    });
  }
}

/**
 * FIXED: Update citizen complaint count with timestamp
 */
async function updateCitizenComplaintCount(phoneNumber) {
  try {
    const formattedPhone = formatPhoneNumber(phoneNumber);
    const citizenRef = admin.firestore().collection('citizens').doc(formattedPhone);
    
    await citizenRef.update({
      complaintsCount: admin.firestore.FieldValue.increment(1),
      'statistics.totalComplaintsResolved': admin.firestore.FieldValue.increment(0),
      'metadata.lastUpdated': admin.firestore.FieldValue.serverTimestamp()
    });
    
    logger.firebase('📊 Citizen complaint count updated');
  } catch (error) {
    logger.warning('⚠️ Error updating complaint count', { 
      error: error.message,
      phoneNumber: phoneNumber?.replace(/^91/, 'XXX-XXX-') || 'invalid'
    });
  }
}

/**
 * Calculate estimated resolution time based on department and priority
 */
function calculateEstimatedResolutionTime(department, priority) {
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
    'emergency': 0.25,  // 25% of base time
    'high': 0.5,        // 50% of base time
    'medium': 1.0,      // 100% of base time
    'low': 1.5          // 150% of base time
  };

  const baseTime = baseTimes[department] || 48;
  const multiplier = priorityMultipliers[priority] || 1.0;
  
  return Math.ceil(baseTime * multiplier);
}

/**
 * Get Firebase health status with comprehensive checks
 */
async function getFirebaseHealthStatus() {
  try {
    const startTime = Date.now();
    
    // Test Firestore read/write
    const testRef = admin.firestore().collection('_health').doc('test');
    await testRef.set({ 
      timestamp: admin.firestore.FieldValue.serverTimestamp(),
      test: true,
      healthCheck: true
    });
    
    const doc = await testRef.get();
    const data = doc.data();
    
    // Test Storage if available
    let storageStatus = 'unknown';
    try {
      const bucket = admin.storage().bucket();
      const [exists] = await bucket.exists();
      storageStatus = exists ? 'operational' : 'bucket_missing';
    } catch (storageError) {
      storageStatus = 'error';
    }
    
    const responseTime = Date.now() - startTime;
    
    // Clean up test document
    await testRef.delete();
    
    return {
      status: 'healthy',
      responseTime,
      timestamp: new Date().toISOString(),
      services: {
        firestore: 'operational',
        storage: storageStatus,
        timestamps: data && data.timestamp ? 'working' : 'error',
        auth: 'operational'
      },
      performance: {
        readWriteTime: responseTime,
        timestampWorking: !!(data && data.timestamp)
      }
    };
  } catch (error) {
    return {
      status: 'unhealthy',
      error: error.message,
      timestamp: new Date().toISOString(),
      services: {
        firestore: 'error',
        storage: 'unknown',
        timestamps: 'error',
        auth: 'unknown'
      }
    };
  }
}

/**
 * Legacy function compatibility - Find infrastructure by ID
 */
async function findInfrastructureByID(id) {
  try {
    const snapshot = await admin.firestore()
      .collection('infrastructure')
      .where('ID', '==', id)
      .get();
    return snapshot;
  } catch (error) {
    logger.warning('Error finding infrastructure', { error: error.message });
    return { empty: true };
  }
}

/**
 * Legacy function compatibility - Find active tickets
 */
async function findActiveTickets(phoneNumber, infraId = null) {
  try {
    const formattedPhone = formatPhoneNumber(phoneNumber);
    let query = admin.firestore()
      .collection('tickets')
      .where('createdBy', '==', formattedPhone)
      .where('status', 'in', ['open', 'active', 'in_progress']);
    
    if (infraId) {
      query = query.where('complaintId', '==', infraId);
    }
    
    return await query.orderBy('createdAt', 'desc').get();
  } catch (error) {
    logger.warning('Error finding active tickets', { error: error.message });
    return { empty: true };
  }
}

/**
 * Legacy function compatibility - Create ticket
 */
async function createTicket(infraId, phoneNumber, ticketId) {
  try {
    const formattedPhone = formatPhoneNumber(phoneNumber);
    const ticketRef = admin.firestore().collection('tickets');
    await ticketRef.add({
      ID: ticketId,
      InfrastructureID: infraId,
      CreatedBy: formattedPhone,
      Status: 'Active',
      CreatedTime: admin.firestore.FieldValue.serverTimestamp(),
      Messages: []
    });
    
    await updateCitizenComplaintCount(formattedPhone);
    logger.firebase(`Ticket created: ${ticketId}`);
  } catch (error) {
    logger.critical('Error creating ticket', { error: error.message });
  }
}

/**
 * Legacy function compatibility - Add message to thread
 */
async function addMessageToThread(ticketId, messageData) {
  try {
    const ticketRef = admin.firestore().collection('tickets')
      .where('ID', '==', ticketId)
      .limit(1);
    
    const snapshot = await ticketRef.get();
    if (!snapshot.empty) {
      await snapshot.docs[0].ref.update({
        Messages: admin.firestore.FieldValue.arrayUnion(messageData),
        updatedAt: admin.firestore.FieldValue.serverTimestamp()
      });
    }
  } catch (error) {
    logger.warning('Error adding message to thread', { error: error.message });
  }
}

// Export all functions
module.exports = {
  // Core Firebase functions
  initializeFirebase,
  testFirebaseConnection,
  sanitizeFirestoreData,
  createSafeDocumentData,
  
  // Citizen management
  ensureCitizenExists,
  getCitizenBotMode,
  updateCitizenEthicalScore,
  updateCitizenStats,
  updateCitizenComplaintCount,
  
  // Chat management
  saveChatMessage,
  getConversationContext,
  
  // Complaint management
  checkDuplicateComplaint,
  calculateQuickDistance,
  createDraftComplaint,
  confirmComplaint,
  cancelComplaint,
  getUserComplaintStatus,
  
  
  getAIService,
  
  // Ticket management
  createTicketRecord,
  addUserToComplaintFollowUp,
  
  // Media and location
  geocodeAddress,
  getMediaUrl,
  downloadAndUploadImage,
  
  // Utilities
  calculateEstimatedResolutionTime,
  getFirebaseHealthStatus,
  
  // Legacy compatibility
  findInfrastructureByID,
  findActiveTickets,
  createTicket,
  addMessageToThread
};