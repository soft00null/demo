// services/aiService.js
const OpenAI = require('openai');
const fs = require('fs');
const path = require('path');
const logger = require('../utils/logger');
const admin = require('firebase-admin');
const { generateTicketId } = require('../utils/helpers');

// Load PCMC knowledge base
const knowledgeBase = require('../knowledgeBase');

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

/**
 * Detect language from text
 */
function detectLanguage(text) {
  const devanagariRegex = /[\u0900-\u097F]/;
  return devanagariRegex.test(text) ? 'marathi' : 'english';
}

/**
 * Create comprehensive system prompt with knowledge base
 */
function createSystemPrompt(language, intentAnalysis, conversationContext = []) {
  const isMarathi = language === 'marathi';
  
  const basePrompt = `You are the official AI assistant for Pimpri-Chinchwad Municipal Corporation (PCMC). You are helpful, humble, respectful, and provide WhatsApp-friendly responses.

CRITICAL INSTRUCTIONS:
1. Always respond in ${isMarathi ? 'Marathi' : 'English'} language only
2. Use simple, conversational WhatsApp-style language (NO markdown, NO *, NO ##, NO -, NO special formatting)
3. Be humble and respectful - use appropriate Marathi/English greetings and courteous language
4. Keep responses concise but informative (under 300 words)
5. Use relevant emojis naturally in conversation
6. For complaints: acknowledge and guide toward registration
7. For queries: provide helpful information from knowledge base
8. For small talk: be friendly and gently redirect to PCMC services

PCMC KNOWLEDGE BASE:
Organization: ${knowledgeBase.organization.name_en} (${knowledgeBase.organization.name_mr})
Mission: ${isMarathi ? knowledgeBase.organization.mission_mr : knowledgeBase.organization.mission_en}

SERVICES:
${knowledgeBase.services.map(service => 
  `• ${isMarathi ? service.name_mr : service.name_en}: ${isMarathi ? service.description_mr : service.description_en} (Helpline: ${service.helpline})`
).join('\n')}

DEPARTMENTS:
${knowledgeBase.departments.join(', ')}

COMPLAINT TYPES:
${knowledgeBase.complaintTypes.join(', ')}

OFFICE DETAILS:
${knowledgeBase.offices.map(office => 
  `${isMarathi ? office.office_name_mr : office.office_name_en}
Address: ${isMarathi ? office.address_mr : office.address_en}
Contact: ${office.contact}
Timings: ${isMarathi ? office.timings_mr : office.timings_en}`
).join('\n')}

FREQUENTLY ASKED QUESTIONS:
${knowledgeBase.faq.map(faq => 
  `Q: ${isMarathi ? faq.question_mr : faq.question_en}
A: ${isMarathi ? faq.answer_mr : faq.answer_en}`
).join('\n')}

EMERGENCY CONTACTS:
${knowledgeBase.emergencyContacts.map(contact => 
  `${isMarathi ? contact.service_mr : contact.service_en}: ${contact.number}`
).join('\n')}

Current conversation context: ${intentAnalysis.context}
User intent: ${intentAnalysis.intent}
Conversation state: ${intentAnalysis.state}

RESPONSE GUIDELINES:
- For service queries: Provide specific information from knowledge base
- For office timings: Always mention 10 AM to 5:30 PM, Monday to Saturday
- For complaints: Guide them to describe the issue for registration
- For contact info: Provide relevant department helpline numbers
- For documents: List required documents clearly
- For fees: Mention applicable charges
- Always end with offering further assistance

Remember: Be conversational, helpful, and represent PCMC professionally while being approachable.`;

  return basePrompt;
}

/**
 * Process message with AI using knowledge base
 */
async function processMessageWithAI(messageText, phoneNumber, intentAnalysis, conversationContext = [], language = 'english') {
  try {
    logger.ai('🤖 Processing message with GPT-4o-mini', {
      phoneNumber: phoneNumber.replace(/^91/, 'XXX-XXX-'),
      intent: intentAnalysis.intent,
      language,
      contextLength: conversationContext.length
    });

    // Create system prompt with knowledge base
    const systemPrompt = createSystemPrompt(language, intentAnalysis, conversationContext);
    
    // Prepare messages for OpenAI
    const messages = [
      { role: 'system', content: systemPrompt },
      ...conversationContext.slice(-5), // Last 5 messages for context
      { role: 'user', content: messageText }
    ];

    logger.debug('Sending request to OpenAI', {
      messageLength: messageText.length,
      systemPromptLength: systemPrompt.length,
      contextMessages: conversationContext.length
    });

    const completion = await openai.chat.completions.create({
      model: 'gpt-4o-mini',
      messages: messages,
      max_tokens: 500,
      temperature: 0.7,
      presence_penalty: 0.1,
      frequency_penalty: 0.1,
    });

    const aiResponse = completion.choices[0].message.content.trim();
    
    // Post-process response to ensure WhatsApp formatting
    const cleanedResponse = cleanWhatsAppResponse(aiResponse, language);
    
    logger.ai('AI response generated successfully', {
      responseLength: cleanedResponse.length,
      tokensUsed: completion.usage?.total_tokens || 0,
      intent: intentAnalysis.intent
    });

    // Check if response suggests location sharing
    const requiresLocation = checkIfLocationRequired(aiResponse, intentAnalysis);
    
    return {
      message: cleanedResponse,
      requiresLocation: requiresLocation.required,
      locationPrompt: requiresLocation.prompt,
      confidence: 0.9,
      tokensUsed: completion.usage?.total_tokens || 0
    };

  } catch (error) {
    logger.critical('Error in AI processing', {
      error: error.message,
      phoneNumber: phoneNumber.replace(/^91/, 'XXX-XXX-'),
      intent: intentAnalysis.intent
    });

    // Fallback response based on intent and language
    return getFallbackResponse(intentAnalysis.intent, language);
  }
}

/**
 * Clean response for WhatsApp formatting
 */
function cleanWhatsAppResponse(response, language) {
  // Remove markdown formatting
  let cleaned = response
    .replace(/\*\*(.*?)\*\*/g, '$1')  // Remove bold **text**
    .replace(/\*(.*?)\*/g, '$1')      // Remove italic *text*
    .replace(/#{1,6}\s/g, '')         // Remove headers ###
    .replace(/`{1,3}(.*?)`{1,3}/g, '$1') // Remove code blocks
    .replace(/\[(.*?)\]\(.*?\)/g, '$1')  // Remove links [text](url)
    .replace(/^\s*[-\*\+]\s/gm, '• ')    // Convert bullet points
    .replace(/^\s*\d+\.\s/gm, '')        // Remove numbered lists
    .replace(/_{2,}/g, '')               // Remove underlines
    .replace(/~{2,}/g, '')               // Remove strikethrough
    .trim();

  // Ensure proper WhatsApp line breaks
  cleaned = cleaned.replace(/\n{3,}/g, '\n\n'); // Max 2 line breaks
  
  // Add natural WhatsApp feel
  if (language === 'marathi') {
    // Ensure Marathi responses are humble and respectful
    if (!cleaned.includes('🙏') && !cleaned.includes('धन्यवाद')) {
      cleaned += '\n\nआणखी काही मदत हवी असल्यास सांगा 🙏';
    }
  } else {
    // Ensure English responses are friendly
    if (!cleaned.includes('help') && !cleaned.includes('assist')) {
      cleaned += '\n\nHow else can I help you today? 😊';
    }
  }

  return cleaned;
}

/**
 * Check if response requires location sharing
 */
function checkIfLocationRequired(response, intentAnalysis) {
  const locationKeywords = [
    'location', 'address', 'where', 'स्थान', 'पत्ता', 'कुठे',
    'site visit', 'inspection', 'तपासणी', 'भेट'
  ];

  const requiresLocation = locationKeywords.some(keyword => 
    response.toLowerCase().includes(keyword.toLowerCase())
  ) && intentAnalysis.intent === 'complaint';

  if (requiresLocation) {
    const prompt = detectLanguage(response) === 'marathi' ?
      'कृपया तुमचे स्थान शेअर करा जेणेकरून आम्ही योग्य कार्यवाही करू शकू' :
      'Please share your location so we can take appropriate action';
    
    return { required: true, prompt };
  }

  return { required: false, prompt: null };
}

/**
 * Get fallback response when AI fails
 */
function getFallbackResponse(intent, language) {
  const isMarathi = language === 'marathi';
  
  const fallbacks = {
    complaint: {
      marathi: 'माफ करा, सध्या तांत्रिक समस्या आहे. तुमची तक्रार नोंदवण्यासाठी कृपया 020-27475000 वर कॉल करा किंवा pcmcindia.gov.in ला भेट द्या. आम्ही लवकरच सेवा सुरळीत करू 🙏',
      english: 'Sorry, technical issue right now. To register your complaint, please call 020-27475000 or visit pcmcindia.gov.in. We will restore service soon 🙏'
    },
    query: {
      marathi: 'माहितीसाठी कृपया PCMC कार्यालयात 020-27475000 वर संपर्क साधा. कार्यालयीन वेळ: सकाळी 10 ते संध्याकाळी 5:30, सोमवार ते शनिवार 📞',
      english: 'For information, please contact PCMC office at 020-27475000. Office hours: 10 AM to 5:30 PM, Monday to Saturday 📞'
    },
    greeting: {
      marathi: 'नमस्कार! PCMC मध्ये आपले स्वागत आहे 🙏 मी तुमची कशी मदत करू शकतो? तक्रारी, माहिती किंवा सेवांबद्दल विचारा 😊',
      english: 'Hello! Welcome to PCMC 🙏 How can I help you? Ask about complaints, information, or services 😊'
    },
    small_talk: {
      marathi: 'धन्यवाद! मी PCMC चा AI सहाय्यक आहे. आज मी तुमची कशी मदत करू शकतो? नागरिक सेवा, तक्रारी किंवा माहितीसाठी विचारा 🏛️',
      english: 'Thank you! I am PCMC AI assistant. How can I help you today? Ask about civic services, complaints, or information 🏛️'
    }
  };

  const response = fallbacks[intent]?.[isMarathi ? 'marathi' : 'english'] || 
                  fallbacks.query[isMarathi ? 'marathi' : 'english'];

  return {
    message: response,
    requiresLocation: false,
    locationPrompt: null,
    confidence: 0.5,
    tokensUsed: 0
  };
}

/**
 * Analyze intent with enhanced context awareness
 */
async function analyzeIntent(message, phoneNumber = null) {
  try {
    logger.ai('🔍 Analyzing message intent', {
      phoneNumber: phoneNumber?.replace(/^91/, 'XXX-XXX-') || 'unknown',
      messageLength: message.length
    });

    const completion = await openai.chat.completions.create({
      model: 'gpt-4o-mini',
      messages: [
        {
          role: 'system', 
          content: `You are an intent analyzer for PCMC (Municipal Corporation). Analyze the message and return ONLY a valid JSON object with these exact fields:

- intent: one of [complaint, query, greeting, small_talk, location_sharing, service_request, document_request, emergency, complaint_status, other]
- context: brief description of what user is talking about (max 50 chars)
- state: one of [new_conversation, ongoing_complaint, information_seeking, casual_chat, urgent_request, status_inquiry]
- confidence: number between 0.1 and 1.0

INTENT GUIDELINES:
- complaint: Issues with municipal services (water, roads, waste, etc.)
- query: Questions about PCMC services, office hours, procedures, fees
- greeting: Hello, hi, good morning, नमस्कार, etc.
- small_talk: Weather, how are you, casual conversation
- service_request: Asking for specific services (certificates, licenses, etc.)
- document_request: Asking about required documents or procedures
- emergency: Urgent issues requiring immediate attention
- complaint_status: Checking complaint status, "my complaints", "track complaint", "complaint status", "मझी तक्रार", "तक्रार स्थिती"
- other: Everything else

COMPLAINT STATUS KEYWORDS:
- "my complaint", "complaint status", "track complaint", "check complaint"
- "मझी तक्रार", "तक्रार स्थिती", "तक्रार तपासा"
- "ticket status", "ticket ID", "complaint list"
- "what is status", "check status", "track my issue"

Return ONLY the JSON object, no other text.`
        },
        {
          role: 'user',
          content: `Message: "${message}"`
        }
      ],
      max_tokens: 150,
      temperature: 0.2,
    });

    const response = completion.choices[0].message.content.trim();
    const cleanResponse = response.replace(/```json|```/g, '').trim();
    
    try {
      const analysis = JSON.parse(cleanResponse);
      
      if (!analysis.intent || !analysis.context || !analysis.state) {
        throw new Error('Missing required fields in intent analysis');
      }
      
      logger.ai('Intent analysis completed', {
        intent: analysis.intent,
        context: analysis.context,
        state: analysis.state,
        confidence: analysis.confidence
      });
      
      return {
        intent: analysis.intent,
        context: analysis.context,
        state: analysis.state,
        confidence: analysis.confidence || 0.8
      };
    } catch (parseError) {
      logger.warning(`JSON parse error for intent analysis: ${cleanResponse}`);
      return getKeywordBasedIntent(message);
    }
  } catch (error) {
    logger.critical(`Error analyzing intent: ${error.message}`);
    return getKeywordBasedIntent(message);
  }
}
/**
 * Keyword-based intent fallback
 */
function getKeywordBasedIntent(message) {
  const lowerMessage = message.toLowerCase();
  
  // Complaint status keywords
  const statusKeywords = [
    'my complaint', 'complaint status', 'track complaint', 'check complaint',
    'ticket status', 'ticket id', 'complaint list', 'my complaints',
    'मझी तक्रार', 'तक्रार स्थिती', 'तक्रार तपासा', 'तक्रार यादी',
    'what is status', 'check status', 'track my issue', 'complaint update'
  ];
  
  // Complaint keywords
  const complaintKeywords = [
    'problem', 'issue', 'complaint', 'broken', 'not working', 'dirty', 'garbage',
    'water', 'road', 'street light', 'drainage', 'sewage',
    'समस्या', 'तक्रार', 'काम नाही', 'गळती', 'कचरा', 'रस्ता', 'पाणी', 'गटार'
  ];
  
  // Query keywords
  const queryKeywords = [
    'how', 'what', 'when', 'where', 'information', 'office', 'timing', 'procedure',
    'कसे', 'काय', 'कधी', 'कुठे', 'माहिती', 'कार्यालय', 'वेळ', 'पद्धत'
  ];
  
  // Greeting keywords
  const greetingKeywords = [
    'hello', 'hi', 'good morning', 'good evening', 'hey',
    'नमस्कार', 'नमस्ते', 'हॅलो', 'हाय'
  ];

  if (statusKeywords.some(keyword => lowerMessage.includes(keyword))) {
    return {
      intent: 'complaint_status',
      context: 'status_inquiry',
      state: 'status_inquiry',
      confidence: 0.9
    };
  } else if (complaintKeywords.some(keyword => lowerMessage.includes(keyword))) {
    return {
      intent: 'complaint',
      context: 'municipal_issue',
      state: 'new_conversation',
      confidence: 0.7
    };
  } else if (queryKeywords.some(keyword => lowerMessage.includes(keyword))) {
    return {
      intent: 'query',
      context: 'information_request',
      state: 'information_seeking',
      confidence: 0.7
    };
  } else if (greetingKeywords.some(keyword => lowerMessage.includes(keyword))) {
    return {
      intent: 'greeting',
      context: 'welcome',
      state: 'new_conversation',
      confidence: 0.8
    };
  }

  return {
    intent: 'other',
    context: 'general',
    state: 'new_conversation',
    confidence: 0.5
  };
}

/**
 * Calculate ethical score for message content
 */
async function calculateEthicalScore(message) {
  try {
    const completion = await openai.chat.completions.create({
      model: 'gpt-4o-mini',
      messages: [
        {
          role: 'system',
          content: `Rate the ethical/appropriateness score of this message on a scale of 1-10:
1-3: Inappropriate, offensive, abusive, threatening
4-6: Neutral, potentially problematic, rude
7-8: Appropriate, respectful, constructive
9-10: Very respectful, polite, constructive

Consider:
- Language appropriateness
- Respectful tone
- Constructive content
- Cultural sensitivity

Return ONLY a single number between 1 and 10.`
        },
        {
          role: 'user',
          content: `Message: "${message}"`
        }
      ],
      max_tokens: 5,
      temperature: 0.1,
    });

    const response = completion.choices[0].message.content.trim();
    const score = parseInt(response.replace(/[^0-9]/g, ''));
    const finalScore = isNaN(score) ? 7 : Math.max(1, Math.min(10, score));
    
    logger.ai('Ethical score calculated', { 
      originalMessage: message.substring(0, 50) + '...',
      score: finalScore 
    });
    
    return finalScore;
  } catch (error) {
    logger.warning(`Error calculating ethical score: ${error.message}`);
    return 7; // Default neutral-positive score
  }
}

/**
 * Transcribe audio using Whisper
 */
async function transcribeAudio(audioPath) {
  try {
    logger.ai('🎵 Transcribing audio with Whisper', { audioPath });
    
    if (!fs.existsSync(audioPath)) {
      throw new Error('Audio file not found');
    }

    const transcription = await openai.audio.transcriptions.create({
      file: fs.createReadStream(audioPath),
      model: 'whisper-1',
      language: 'en', // Hindi/Marathi support
      prompt: 'This is a voice message from an Indian citizen to PCMC municipal corporation about civic issues, complaints, or queries in Hindi, Marathi, or English.'
    });

    const transcript = transcription.text.trim();
    
    logger.ai('Audio transcription completed', { 
      transcriptLength: transcript.length,
      transcriptPreview: transcript.substring(0, 100) + '...'
    });
    
    return transcript || 'Could not transcribe audio clearly';
  } catch (error) {
    logger.critical(`Error transcribing audio: ${error.message}`, { audioPath });
    return 'माफ करा, ऑडिओ स्पष्ट नाही. कृपया मजकूर संदेश पाठवा. Sorry, audio unclear. Please send text message.';
  }
}

/**
 * Analyze image content
 */
async function analyzeImageContent(imageUrl) {
  try {
    logger.ai('🖼️ Analyzing image content', { imageUrl: imageUrl.substring(0, 50) + '...' });

    const completion = await openai.chat.completions.create({
      model: 'gpt-4o-mini',
      messages: [
        {
          role: 'user',
          content: [
            {
              type: 'text',
              text: 'Analyze this image and describe any municipal issues, infrastructure problems, or civic concerns visible. If no civic issues are visible, describe what you see briefly. Focus on: roads, water, drainage, garbage, street lights, buildings, public facilities. Keep response under 100 words in simple language.'
            },
            {
              type: 'image_url',
              image_url: { url: imageUrl }
            }
          ]
        }
      ],
      max_tokens: 200,
      temperature: 0.3,
    });

    const analysis = completion.choices[0].message.content.trim();
    
    logger.ai('Image analysis completed', { 
      analysisLength: analysis.length,
      analysisPreview: analysis.substring(0, 50) + '...'
    });
    
    return analysis || 'Could not analyze image clearly';
  } catch (error) {
    logger.critical(`Error analyzing image: ${error.message}`);
    return 'प्रतिमा विश्लेषण करता आले नाही. Could not analyze image.';
  }
}

/**
 * Categorize department for complaint
 */
async function categorizeDepartment(description) {
  try {
    const completion = await openai.chat.completions.create({
      model: 'gpt-4o-mini',
      messages: [
        {
          role: 'system',
          content: `Categorize this municipal complaint into the most appropriate PCMC department:

DEPARTMENTS:
- Water Supply (पाणीपुरवठा)
- Waste Management (घनकचरा व्यवस्थापन)
- Roads & Infrastructure (रस्ते आणि पायाभूत सुविधा)
- Health & Sanitation (आरोग्य आणि स्वच्छता)
- Building & Planning (इमारत आणि नगररचना)
- Electricity (वीज)
- Parks & Recreation (उद्यान आणि मनोरंजन)
- Traffic & Transport (वाहतूक आणि परिवहन)
- Property Tax (मालमत्ता कर)
- General Administration (सामान्य प्रशासन)

Return ONLY the department name from the list above.`
        },
        {
          role: 'user',
          content: `Complaint: "${description}"`
        }
      ],
      max_tokens: 20,
      temperature: 0.2,
    });

    const department = completion.choices[0].message.content.trim();
    
    // Validate department
    const validDepartments = [
      'Water Supply', 'Waste Management', 'Roads & Infrastructure',
      'Health & Sanitation', 'Building & Planning', 'Electricity',
      'Parks & Recreation', 'Traffic & Transport', 'Property Tax',
      'General Administration'
    ];
    
    const finalDepartment = validDepartments.includes(department) ? department : 'General Administration';
    
    logger.ai('Department categorized', { 
      complaint: description.substring(0, 50) + '...',
      department: finalDepartment 
    });
    
    return finalDepartment;
  } catch (error) {
    logger.warning(`Error categorizing department: ${error.message}`);
    return 'General Administration';
  }
}

/**
 * Assess complaint priority
 */
async function assessComplaintPriority(description) {
  try {
    const completion = await openai.chat.completions.create({
      model: 'gpt-4o-mini',
      messages: [
        {
          role: 'system',
          content: `Assess the priority level of this municipal complaint:

PRIORITY LEVELS:
- emergency: Life-threatening, major safety hazards, complete service failure
- high: Significant impact on daily life, health risks, major inconvenience
- medium: Standard civic issues, moderate inconvenience
- low: Minor issues, aesthetic concerns, suggestions

Return ONLY one word: emergency, high, medium, or low`
        },
        {
          role: 'user',
          content: `Complaint: "${description}"`
        }
      ],
      max_tokens: 10,
      temperature: 0.2,
    });

    const priority = completion.choices[0].message.content.trim().toLowerCase();
    
    const validPriorities = ['emergency', 'high', 'medium', 'low'];
    const finalPriority = validPriorities.includes(priority) ? priority : 'medium';
    
    logger.ai('Priority assessed', { 
      complaint: description.substring(0, 50) + '...',
      priority: finalPriority 
    });
    
    return finalPriority;
  } catch (error) {
    logger.warning(`Error assessing priority: ${error.message}`);
    return 'medium';
  }
}

/**
 * Categorize complaint type
 */
async function categorizeComplaintType(description) {
  try {
    const completion = await openai.chat.completions.create({
      model: 'gpt-4o-mini',
      messages: [
        {
          role: 'system',
          content: `Categorize this complaint into a specific type:

COMPLAINT TYPES:
- Water supply issues
- Drainage and sewerage problems
- Road maintenance
- Street light issues
- Garbage collection
- Building permission queries
- Property tax issues
- Health and sanitation
- Traffic and parking
- Park maintenance
- Administrative issues
- Corruption complaints

Return ONLY the complaint type from the list above.`
        },
        {
          role: 'user',
          content: `Complaint: "${description}"`
        }
      ],
      max_tokens: 20,
      temperature: 0.2,
    });

    const category = completion.choices[0].message.content.trim();
    
    const validCategories = [
      'Water supply issues', 'Drainage and sewerage problems', 'Road maintenance',
      'Street light issues', 'Garbage collection', 'Building permission queries',
      'Property tax issues', 'Health and sanitation', 'Traffic and parking',
      'Park maintenance', 'Administrative issues', 'Corruption complaints'
    ];
    
    const finalCategory = validCategories.includes(category) ? category : 'Administrative issues';
    
    logger.ai('Complaint type categorized', { 
      complaint: description.substring(0, 50) + '...',
      category: finalCategory 
    });
    
    return finalCategory;
  } catch (error) {
    logger.warning(`Error categorizing complaint type: ${error.message}`);
    return 'Administrative issues';
  }
}

/**
 * Check complaint similarity for duplicate detection
 */
async function checkComplaintSimilarity(newComplaint, existingComplaint) {
  try {
    const completion = await openai.chat.completions.create({
      model: 'gpt-4o-mini',
      messages: [
        {
          role: 'system',
          content: `Compare these two municipal complaints and return a similarity score from 0.0 to 1.0:
- 0.0-0.3: Different issues
- 0.4-0.6: Related but distinct issues  
- 0.7-0.8: Similar issues, possibly same location/type
- 0.9-1.0: Very similar or duplicate issues

Return ONLY a decimal number between 0.0 and 1.0`
        },
        {
          role: 'user',
          content: `New complaint: "${newComplaint}"\nExisting complaint: "${existingComplaint}"`
        }
      ],
      max_tokens: 5,
      temperature: 0.1,
    });

    const scoreText = completion.choices[0].message.content.trim();
    const score = parseFloat(scoreText);
    const finalScore = isNaN(score) ? 0.0 : Math.max(0.0, Math.min(1.0, score));
    
    logger.ai('Complaint similarity checked', { 
      newComplaint: newComplaint.substring(0, 30) + '...',
      existingComplaint: existingComplaint.substring(0, 30) + '...',
      similarity: finalScore 
    });
    
    return { score: finalScore, confidence: 0.8 };
  } catch (error) {
    logger.warning(`Error checking complaint similarity: ${error.message}`);
    return { score: 0.0, confidence: 0.1 };
  }
}

// Export all functions
module.exports = {
  processMessageWithAI,
  analyzeIntent,
  calculateEthicalScore,
  transcribeAudio,
  analyzeImageContent,
  detectLanguage,
  categorizeDepartment,
  assessComplaintPriority,
  categorizeComplaintType,
  checkComplaintSimilarity,
  
  // Utility functions
  cleanWhatsAppResponse,
  createSystemPrompt,
  getFallbackResponse
};