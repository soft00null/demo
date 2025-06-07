// services/firebaseService.js
const admin = require('firebase-admin');
const axios = require('axios');
const { v4: uuidv4 } = require('uuid');
const logger = require('../utils/logger');
const { generateTicketId } = require('../utils/helpers');

let firebaseInitialized = false;

/**
 * Initialize Firebase Admin SDK
 */
function initializeFirebase() {
  if (!firebaseInitialized) {
    try {
      const serviceAccount = require(process.env.FIREBASE_SERVICE_ACCOUNT_PATH);
      admin.initializeApp({
        credential: admin.credential.cert(serviceAccount),
        storageBucket: process.env.FIREBASE_STORAGE_BUCKET || 'pcmc-889cf.firebasestorage.app'
      });
      firebaseInitialized = true;
      logger.firebase('Firebase initialized successfully');
    } catch (error) {
      logger.critical(`Firebase initialization error: ${error.message}`);
      throw error;
    }
  }
}

/**
 * Sanitize data for Firestore by removing undefined values and converting them to null
 */
function sanitizeFirestoreData(data) {
  if (data === undefined) {
    return null;
  }
  
  if (data === null || typeof data !== 'object') {
    return data;
  }
  
  if (Array.isArray(data)) {
    return data.map(item => sanitizeFirestoreData(item));
  }
  
  const sanitized = {};
  for (const [key, value] of Object.entries(data)) {
    if (value !== undefined) {
      sanitized[key] = sanitizeFirestoreData(value);
    }
    // Skip undefined values completely - they won't be included in Firestore document
  }
  
  return sanitized;
}

/**
 * Ensure citizen exists in database with enhanced schema
 */
async function ensureCitizenExists(phoneNumber, name) {
  try {
    logger.firebase('Ensuring citizen exists', { phoneNumber: phoneNumber.replace(/^91/, 'XXX') });
    
    const citizenRef = admin.firestore().collection('citizens').doc(phoneNumber);
    const citizenDoc = await citizenRef.get();
    
    if (!citizenDoc.exists) {
      const newCitizen = sanitizeFirestoreData({
        phoneNumber,
        name,
        botMode: true,
        ethicalScore: 7.5,
        totalMessages: 0,
        complaintsCount: 0,
        queriesCount: 0,
        lastActiveAt: admin.firestore.FieldValue.serverTimestamp(),
        createdAt: admin.firestore.FieldValue.serverTimestamp(),
        profile: {
          preferredLanguage: 'auto',
          notificationsEnabled: true,
          location: null
        },
        statistics: {
          avgEthicalScore: 7.5,
          avgResponseTime: 0,
          totalSessions: 1,
          lastSessionDuration: 0
        }
      });
      
      await citizenRef.set(newCitizen);
      logger.citizen(`New citizen created: ${phoneNumber.replace(/^91/, 'XXX')} (${name})`);
    } else {
      const updateData = sanitizeFirestoreData({
        lastActiveAt: admin.firestore.FieldValue.serverTimestamp(),
        totalMessages: admin.firestore.FieldValue.increment(1),
        name: name
      });
      
      await citizenRef.update(updateData);
      logger.firebase('Citizen updated', { phoneNumber: phoneNumber.replace(/^91/, 'XXX') });
    }
  } catch (error) {
    logger.critical(`Error ensuring citizen exists: ${error.message}`, { 
      phoneNumber: phoneNumber.replace(/^91/, 'XXX'), 
      name 
    });
    throw error;
  }
}

/**
 * Get citizen's bot mode status
 */
async function getCitizenBotMode(phoneNumber) {
  try {
    logger.firebase('Getting citizen bot mode', { phoneNumber: phoneNumber.replace(/^91/, 'XXX') });
    
    const citizenRef = admin.firestore().collection('citizens').doc(phoneNumber);
    const citizenDoc = await citizenRef.get();
    
    if (citizenDoc.exists) {
      const botMode = citizenDoc.data().botMode !== false;
      logger.firebase('Bot mode retrieved', { phoneNumber: phoneNumber.replace(/^91/, 'XXX'), botMode });
      return botMode;
    }
    
    logger.firebase('Citizen not found, defaulting bot mode to true', { phoneNumber: phoneNumber.replace(/^91/, 'XXX') });
    return true;
  } catch (error) {
    logger.critical(`Error getting citizen bot mode: ${error.message}`, { phoneNumber: phoneNumber.replace(/^91/, 'XXX') });
    return true;
  }
}

/**
 * Save chat message to conversation history with proper sanitization
 */
async function saveChatMessage(phoneNumber, messageData) {
  try {
    logger.firebase('Saving chat message', { 
      phoneNumber: phoneNumber.replace(/^91/, 'XXX'),
      messageType: messageData.messageType,
      intent: messageData.intent
    });
    
    const chatRef = admin.firestore()
      .collection('citizens')
      .doc(phoneNumber)
      .collection('chats');
    
    // Sanitize the message data to remove undefined values
    const sanitizedMessageData = sanitizeFirestoreData({
      ...messageData,
      createdAt: admin.firestore.FieldValue.serverTimestamp()
    });
    
    logger.debug('Sanitized message data for Firestore', {
      originalKeys: Object.keys(messageData),
      sanitizedKeys: Object.keys(sanitizedMessageData),
      messageType: messageData.messageType
    });
    
    await chatRef.add(sanitizedMessageData);
    
    // Update citizen statistics
    await updateCitizenStats(phoneNumber, messageData);
    
    logger.success(`Chat message saved for ${phoneNumber.replace(/^91/, 'XXX')}`, { 
      type: messageData.messageType,
      intent: messageData.intent 
    });
  } catch (error) {
    logger.critical(`Error saving chat message: ${error.message}`, { 
      phoneNumber: phoneNumber.replace(/^91/, 'XXX'),
      messageType: messageData.messageType,
      error: error.stack
    });
    throw error;
  }
}

/**
 * Get conversation context for AI processing
 */
async function getConversationContext(phoneNumber, limit = 10) {
  try {
    logger.firebase('Getting conversation context', { 
      phoneNumber: phoneNumber.replace(/^91/, 'XXX'),
      limit 
    });
    
    const chatsRef = admin.firestore()
      .collection('citizens')
      .doc(phoneNumber)
      .collection('chats');
    
    const snapshot = await chatsRef
      .orderBy('createdAt', 'desc')
      .limit(limit)
      .get();
    
    const context = [];
    snapshot.docs.reverse().forEach(doc => {
      const data = doc.data();
      if (data.messageType === 'text' && data.content) {
        context.push({
          role: data.sender === phoneNumber ? 'user' : 'assistant',
          content: data.content,
          timestamp: data.createdAt,
          intent: data.intent,
          context: data.context
        });
      }
    });
    
    logger.firebase('Conversation context retrieved', { 
      phoneNumber: phoneNumber.replace(/^91/, 'XXX'),
      contextLength: context.length 
    });
    
    return context;
  } catch (error) {
    logger.critical(`Error getting conversation context: ${error.message}`, { phoneNumber: phoneNumber.replace(/^91/, 'XXX') });
    return [];
  }
}

/**
 * Update citizen's ethical score with weighted averaging
 */
async function updateCitizenEthicalScore(phoneNumber, messageEthicalScore) {
  try {
    logger.firebase('Updating citizen ethical score', { 
      phoneNumber: phoneNumber.replace(/^91/, 'XXX'),
      newScore: messageEthicalScore 
    });
    
    const citizenRef = admin.firestore().collection('citizens').doc(phoneNumber);
    const citizenDoc = await citizenRef.get();
    
    if (citizenDoc.exists) {
      const currentData = citizenDoc.data();
      const currentScore = currentData.ethicalScore || 7.5;
      const totalMessages = currentData.totalMessages || 1;
      
      const weight = Math.min(totalMessages, 50);
      const newScore = ((currentScore * weight) + (messageEthicalScore * 3)) / (weight + 3);
      const roundedScore = Math.round(newScore * 10) / 10;
      
      const updateData = sanitizeFirestoreData({
        ethicalScore: Math.max(1, Math.min(10, roundedScore)),
        'statistics.avgEthicalScore': roundedScore
      });
      
      await citizenRef.update(updateData);
      
      logger.firebase(`Ethical score updated for ${phoneNumber.replace(/^91/, 'XXX')}`, { 
        oldScore: currentScore, 
        newScore: roundedScore,
        messageScore: messageEthicalScore 
      });
    }
  } catch (error) {
    logger.critical(`Error updating citizen ethical score: ${error.message}`, { phoneNumber: phoneNumber.replace(/^91/, 'XXX') });
  }
}

/**
 * Update citizen statistics
 */
async function updateCitizenStats(phoneNumber, messageData) {
  try {
    const citizenRef = admin.firestore().collection('citizens').doc(phoneNumber);
    const updates = {};
    
    if (messageData.intent === 'complaint') {
      updates.complaintsCount = admin.firestore.FieldValue.increment(1);
    } else if (messageData.intent === 'query') {
      updates.queriesCount = admin.firestore.FieldValue.increment(1);
    }
    
    if (messageData.language && messageData.sender === phoneNumber) {
      updates['profile.preferredLanguage'] = messageData.language;
    }
    
    const sanitizedUpdates = sanitizeFirestoreData(updates);
    
    if (Object.keys(sanitizedUpdates).length > 0) {
      await citizenRef.update(sanitizedUpdates);
      logger.firebase('Citizen stats updated', { phoneNumber: phoneNumber.replace(/^91/, 'XXX'), updates: sanitizedUpdates });
    }
  } catch (error) {
    logger.critical(`Error updating citizen stats: ${error.message}`, { phoneNumber: phoneNumber.replace(/^91/, 'XXX') });
  }
}

/**
 * Check for duplicate complaints using AI similarity detection
 */
async function checkDuplicateComplaint(complaintText, phoneNumber, location = null) {
  try {
    logger.firebase('Checking for duplicate complaints', { 
      phoneNumber: phoneNumber.replace(/^91/, 'XXX'),
      complaintPreview: complaintText.substring(0, 50) + '...'
    });
    
    const complaintsRef = admin.firestore().collection('complaints');
    let query = complaintsRef
      .where('status', 'in', ['active', 'in_progress'])
      .orderBy('createdAt', 'desc')
      .limit(50);

    const snapshot = await query.get();
    
    if (snapshot.empty) {
      logger.firebase('No existing complaints found for duplicate check');
      return { isDuplicate: false };
    }

    const { checkComplaintSimilarity } = require('./aiService');
    
    for (const doc of snapshot.docs) {
      const existingComplaint = doc.data();
      
      const similarity = await checkComplaintSimilarity(complaintText, existingComplaint.description);
      
      if (similarity.score > 0.8) {
        await addUserToComplaintFollowUp(doc.id, phoneNumber);
        
        logger.firebase('Duplicate complaint detected', {
          phoneNumber: phoneNumber.replace(/^91/, 'XXX'),
          existingTicketId: existingComplaint.ticketId,
          similarityScore: similarity.score
        });
        
        return {
          isDuplicate: true,
          ticketId: existingComplaint.ticketId,
          status: existingComplaint.status,
          similarity: similarity.score
        };
      }
    }
    
    logger.firebase('No duplicate complaints found');
    return { isDuplicate: false };
  } catch (error) {
    logger.critical(`Error checking duplicate complaint: ${error.message}`, { phoneNumber: phoneNumber.replace(/^91/, 'XXX') });
    return { isDuplicate: false };
  }
}

/**
 * Create draft complaint for confirmation
 */
async function createDraftComplaint(description, phoneNumber, intentAnalysis, imageUrl = null) {
  try {
    const complaintId = generateTicketId(12);
    const department = await getDepartmentFromComplaint(description);
    
    logger.firebase('Creating draft complaint', {
      complaintId,
      phoneNumber: phoneNumber.replace(/^91/, 'XXX'),
      department
    });
    
    const draftComplaint = sanitizeFirestoreData({
      id: complaintId,
      description,
      department,
      createdBy: phoneNumber,
      status: 'draft',
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
      intent: intentAnalysis.intent,
      context: intentAnalysis.context,
      state: intentAnalysis.state,
      priority: await calculateComplaintPriority(description),
      category: await categorizeComplaint(description),
      location: null, // Will be filled when WhatsApp location is shared
      imageUrl: imageUrl,
      estimatedResolutionTime: await estimateResolutionTime(department),
      requiresLocationSharing: true // Flag to indicate location is needed
    });

    const complaintRef = admin.firestore().collection('complaints').doc(complaintId);
    await complaintRef.set(draftComplaint);
    
    logger.success(`Draft complaint created: ${complaintId}`, { 
      phoneNumber: phoneNumber.replace(/^91/, 'XXX'), 
      department, 
      category: draftComplaint.category 
    });
    
    return draftComplaint;
  } catch (error) {
    logger.critical(`Error creating draft complaint: ${error.message}`, { phoneNumber: phoneNumber.replace(/^91/, 'XXX') });
    throw error;
  }
}

/**
 * Confirm complaint with WhatsApp location data only
 */
async function confirmComplaint(complaintId, whatsappLocationData) {
  try {
    logger.firebase('Confirming complaint with WhatsApp location', { complaintId });
    
    const complaintRef = admin.firestore().collection('complaints').doc(complaintId);
    const complaintDoc = await complaintRef.get();
    
    if (!complaintDoc.exists) {
      throw new Error('Complaint not found');
    }

    const ticketId = generateTicketId(8);
    
    // Sanitize location data from WhatsApp
    const sanitizedLocationData = sanitizeFirestoreData({
      latitude: whatsappLocationData.latitude,
      longitude: whatsappLocationData.longitude,
      address: whatsappLocationData.address || null,
      name: whatsappLocationData.name || null,
      source: 'whatsapp_location'
    });
    
    const updateData = sanitizeFirestoreData({
      status: 'active',
      ticketId,
      location: sanitizedLocationData,
      confirmedAt: admin.firestore.FieldValue.serverTimestamp(),
      requiresLocationSharing: false
    });
    
    await complaintRef.update(updateData);

    // Create ticket in tickets collection for tracking
    await createTicketRecord(ticketId, complaintId, complaintDoc.data(), sanitizedLocationData);
    
    logger.success(`Complaint confirmed: ${complaintId} -> Ticket: ${ticketId}`);
    
    return ticketId;
  } catch (error) {
    logger.critical(`Error confirming complaint: ${error.message}`, { complaintId });
    throw error;
  }
}

/**
 * Cancel draft complaint
 */
async function cancelComplaint(complaintId) {
  try {
    logger.firebase('Cancelling complaint', { complaintId });
    
    const complaintRef = admin.firestore().collection('complaints').doc(complaintId);
    const updateData = sanitizeFirestoreData({
      status: 'cancelled',
      cancelledAt: admin.firestore.FieldValue.serverTimestamp()
    });
    
    await complaintRef.update(updateData);
    
    logger.firebase(`Complaint cancelled: ${complaintId}`);
  } catch (error) {
    logger.critical(`Error cancelling complaint: ${error.message}`, { complaintId });
    throw error;
  }
}

/**
 * Geocode coordinates to address using Google Maps API
 */
async function geocodeAddress(latitude, longitude) {
  try {
    logger.firebase('Geocoding coordinates', { latitude, longitude });
    
    const response = await axios.get('https://maps.googleapis.com/maps/api/geocode/json', {
      params: {
        latlng: `${latitude},${longitude}`,
        key: process.env.GOOGLE_MAPS_API_KEY
      }
    });
    
    if (response.data.results && response.data.results.length > 0) {
      const address = response.data.results[0].formatted_address;
      logger.firebase('Coordinates geocoded successfully', { latitude, longitude, address });
      return address;
    }
    
    const fallbackAddress = `${latitude}, ${longitude}`;
    logger.warning('Geocoding failed, using coordinates', { latitude, longitude });
    return fallbackAddress;
  } catch (error) {
    logger.critical(`Error geocoding address: ${error.message}`, { latitude, longitude });
    return `${latitude}, ${longitude}`;
  }
}

/**
 * Get media URL from WhatsApp
 */
async function getMediaUrl(mediaId) {
  try {
    logger.whatsapp('Getting media URL', { mediaId });
    
    const response = await axios.get(`https://graph.facebook.com/v18.0/${mediaId}`, {
      headers: { 
        'Authorization': `Bearer ${process.env.WHATSAPP_TOKEN}` 
      }
    });
    
    logger.whatsapp('Media URL retrieved successfully', { mediaId });
    return response.data.url;
  } catch (error) {
    logger.critical(`Error getting media URL: ${error.message}`, { mediaId });
    throw error;
  }
}

/**
 * Download and upload image to Firebase Storage
 */
async function downloadAndUploadImage(mediaUrl, mediaId) {
  try {
    logger.firebase('Downloading and uploading image', { mediaId });
    
    const response = await axios.get(mediaUrl, {
      responseType: 'arraybuffer',
      headers: { 
        'Authorization': `Bearer ${process.env.WHATSAPP_TOKEN}` 
      }
    });
    
    const bucket = admin.storage().bucket();
    const fileName = `images/${mediaId}_${Date.now()}.jpg`;
    const file = bucket.file(fileName);
    
    await file.save(Buffer.from(response.data), {
      metadata: { 
        contentType: 'image/jpeg',
        metadata: {
          originalMediaId: mediaId,
          uploadedAt: new Date().toISOString()
        }
      }
    });
    
    await file.makePublic();
    const publicUrl = `https://storage.googleapis.com/${bucket.name}/${fileName}`;
    
    logger.success(`Image uploaded successfully: ${fileName}`);
    return publicUrl;
  } catch (error) {
    logger.critical(`Error uploading image: ${error.message}`, { mediaId });
    throw error;
  }
}

// Helper functions
async function getDepartmentFromComplaint(description) {
  const { categorizeDepartment } = require('./aiService');
  return await categorizeDepartment(description);
}

async function calculateComplaintPriority(description) {
  const { assessComplaintPriority } = require('./aiService');
  return await assessComplaintPriority(description);
}

async function categorizeComplaint(description) {
  const { categorizeComplaintType } = require('./aiService');
  return await categorizeComplaintType(description);
}

async function estimateResolutionTime(department) {
  const estimates = {
    'Water Supply': 24,
    'Waste Management': 48,
    'Roads & Infrastructure': 72,
    'Health & Sanitation': 24,
    'Building & Planning': 168,
    'Electricity': 12,
    'Parks & Recreation': 48,
    'Traffic & Transport': 24,
    'Property Tax': 72,
    'General Administration': 48
  };
  
  return estimates[department] || 48;
}

async function createTicketRecord(ticketId, complaintId, complaintData, locationData) {
  try {
    logger.firebase('Creating ticket record', { ticketId, complaintId });
    
    const ticketData = sanitizeFirestoreData({
      ticketId,
      complaintId,
      createdBy: complaintData.createdBy,
      department: complaintData.department,
      status: 'open',
      priority: complaintData.priority,
      category: complaintData.category,
      description: complaintData.description,
      location: locationData,
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
      estimatedResolution: new Date(Date.now() + complaintData.estimatedResolutionTime * 60 * 60 * 1000),
      assignedTo: null,
      updates: [],
      followUpUsers: [complaintData.createdBy]
    });
    
    const ticketRef = admin.firestore().collection('tickets').doc(ticketId);
    await ticketRef.set(ticketData);
    
    logger.success('Ticket record created successfully', { ticketId });
  } catch (error) {
    logger.critical(`Error creating ticket record: ${error.message}`, { ticketId });
  }
}

async function addUserToComplaintFollowUp(complaintId, phoneNumber) {
  try {
    logger.firebase('Adding user to complaint follow-up', { complaintId, phoneNumber: phoneNumber.replace(/^91/, 'XXX') });
    
    const complaintRef = admin.firestore().collection('complaints').doc(complaintId);
    await complaintRef.update({
      followUpUsers: admin.firestore.FieldValue.arrayUnion(phoneNumber)
    });
    
    logger.firebase('User added to follow-up successfully');
  } catch (error) {
    logger.critical(`Error adding user to follow-up: ${error.message}`, { complaintId, phoneNumber: phoneNumber.replace(/^91/, 'XXX') });
  }
}

// Export all functions
module.exports = {
  initializeFirebase,
  sanitizeFirestoreData, // Export the new sanitization function
  ensureCitizenExists,
  getCitizenBotMode,
  saveChatMessage,
  getConversationContext,
  updateCitizenEthicalScore,
  checkDuplicateComplaint,
  createDraftComplaint,
  confirmComplaint,
  cancelComplaint,
  geocodeAddress, // Only geocoding, no address-to-location conversion
  getMediaUrl,
  downloadAndUploadImage
};