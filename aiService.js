// services/aiService.js - Complete AI service with GPT-4o-mini integration
const OpenAI = require('openai');
const logger = require('../utils/logger');
const knowledgeBase = require('../knowledgeBase');
const { containsDevanagari, sanitizeInput } = require('../utils/helpers');

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

// AI Configuration
const AI_CONFIG = {
  model: 'gpt-4o-mini',
  maxTokens: 500,
  temperature: 0.7,
  duplicateThreshold: 0.8,
  supportedLanguages: ['english', 'marathi', 'hindi']
};

/*
 * Main AI processing function for WhatsApp messages
 */
async function processMessageWithAI(messageText, phoneNumber, intentAnalysis, conversationContext = [], language = 'auto') {
  try {
    logger.ai('🤖 Processing message with GPT-4o-mini', {
      phoneNumber: phoneNumber.replace(/^91/, 'XXX-XXX-'),
      intent: intentAnalysis.intent,
      language,
      contextLength: conversationContext.length
    });

    // Detect language if auto
    if (language === 'auto') {
      language = detectLanguage(messageText);
    }

    // Create system prompt based on intent and language
    const systemPrompt = createSystemPrompt(intentAnalysis, language);
    
    // Build conversation messages
    const messages = [
      { role: 'system', content: systemPrompt },
      ...conversationContext.slice(-5), // Last 5 messages for context
      { role: 'user', content: messageText }
    ];

    const completion = await openai.chat.completions.create({
      model: AI_CONFIG.model,
      messages: messages,
      max_tokens: AI_CONFIG.maxTokens,
      temperature: AI_CONFIG.temperature,
    });

    const response = completion.choices[0].message.content;
    
    // Check if location is required based on response
    const requiresLocation = await checkIfLocationRequired(messageText, response);
    
    logger.success('✅ AI processing completed', {
      phoneNumber: phoneNumber.replace(/^91/, 'XXX-XXX-'),
      responseLength: response.length,
      requiresLocation
    });

    return {
      message: response,
      requiresLocation,
      locationPrompt: requiresLocation ? getLocationPrompt(language) : null,
      confidence: intentAnalysis.confidence || 0.8,
      language
    };

  } catch (error) {
    logger.critical('💥 Error in AI processing', {
      error: error.message,
      phoneNumber: phoneNumber.replace(/^91/, 'XXX-XXX-'),
      stack: error.stack
    });

    // Fallback response
    const fallbackMessage = language === 'marathi' 
      ? '😔 माफ करा, मी सध्या तुमची मदत करू शकत नाही. कृपया पुन्हा प्रयत्न करा.\n\n📞 तातडीच्या मदतीसाठी: 020-27475000\n\n🏛️ *PCMC सेवा*'
      : '😔 Sorry, I cannot help you right now. Please try again later.\n\n📞 For urgent help: 020-27475000\n\n🏛️ *PCMC Service*';

    return {
      message: fallbackMessage,
      requiresLocation: false,
      confidence: 0.1,
      language
    };
  }
}

/*
 * Analyze message intent using GPT-4o-mini
 */
async function analyzeIntent(messageText, phoneNumber = null) {
  try {
    logger.ai('🔍 Analyzing message intent', {
      phoneNumber: phoneNumber?.replace(/^91/, 'XXX-XXX-') || 'unknown',
      messageLength: messageText.length
    });

    // Special case: Check for complaint status queries first
    if (isComplaintStatusQuery(messageText)) {
      return {
        intent: 'complaint_status',
        context: 'status_inquiry',
        state: 'status_requested',
        confidence: 0.95,
        language: detectLanguage(messageText)
      };
    }

    const completion = await openai.chat.completions.create({
      model: AI_CONFIG.model,
      messages: [
        {
          role: 'system',
          content: `You are an intent analyzer for PCMC (Municipal Corporation) WhatsApp bot. Analyze the message and return ONLY a valid JSON object with these exact fields:

- intent: one of [complaint, complaint_status, query, small_talk, location_sharing, greeting, other]
- context: brief description of what user is talking about
- state: one of [new_conversation, ongoing_complaint, information_seeking, casual_chat, status_requested]
- confidence: number between 0.0 and 1.0
- language: detected language (english/marathi/hindi)

IMPORTANT DETECTION RULES:
- complaint_status: for queries like "my complaints", "माझ्या तक्रारी", "complaint status", "तक्रार स्थिती"
- complaint: for municipal issues, problems, service requests
- query: for information seeking about PCMC services
- greeting: for hello, hi, नमस्कार, नमस्ते
- small_talk: for casual conversation

Return ONLY the JSON object, no other text.

Examples:
{"intent": "complaint_status", "context": "checking complaint status", "state": "status_requested", "confidence": 0.9, "language": "english"}
{"intent": "complaint", "context": "water supply issue", "state": "new_conversation", "confidence": 0.8, "language": "marathi"}`
        },
        {
          role: 'user',
          content: `Message: "${messageText}"`
        }
      ],
      max_tokens: 150,
      temperature: 0.1,
    });

    const response = completion.choices[0].message.content.trim();
    const cleanResponse = response.replace(/```json|```/g, '').trim();
    
    try {
      const analysis = JSON.parse(cleanResponse);
      
      // Validate and set defaults
      analysis.intent = analysis.intent || 'other';
      analysis.context = analysis.context || 'general';
      analysis.state = analysis.state || 'new_conversation';
      analysis.confidence = analysis.confidence || 0.7;
      analysis.language = analysis.language || detectLanguage(messageText);
      
      logger.ai('✅ Intent analysis completed', {
        intent: analysis.intent,
        context: analysis.context,
        confidence: analysis.confidence,
        language: analysis.language
      });
      
      return analysis;
    } catch (parseError) {
      logger.warning('⚠️ JSON parse error in intent analysis', {
        response: cleanResponse,
        error: parseError.message
      });
      
      // Fallback analysis
      return {
        intent: 'other',
        context: 'general',
        state: 'new_conversation',
        confidence: 0.5,
        language: detectLanguage(messageText)
      };
    }
  } catch (error) {
    logger.critical('💥 Error analyzing intent', {
      error: error.message,
      stack: error.stack
    });
    
    return {
      intent: 'other',
      context: 'general',
      state: 'new_conversation',
      confidence: 0.3,
      language: detectLanguage(messageText)
    };
  }
}

/*
 * FEATURE 2: Check complaint similarity using GPT-4o-mini
 */
async function checkComplaintSimilarity(newComplaint, existingComplaint, newLocation = null, existingLocation = null, newImageUrl = null, existingImageUrl = null) {
  try {
    logger.ai('🔍 Enhanced complaint similarity analysis', {
      newComplaintLength: newComplaint.length,
      existingComplaintLength: existingComplaint.length,
      hasNewLocation: !!newLocation,
      hasExistingLocation: !!existingLocation,
      hasNewImage: !!newImageUrl,
      hasExistingImage: !!existingImageUrl
    });

    // 1. SEMANTIC SIMILARITY ANALYSIS
    const semanticAnalysis = await analyzeSemanticSimilarity(newComplaint, existingComplaint);
    
    // 2. LOCATION PROXIMITY ANALYSIS
    const locationAnalysis = await analyzeLocationProximity(newLocation, existingLocation);
    
    // 3. IMAGE SIMILARITY ANALYSIS (if both have images)
    const imageAnalysis = await analyzeImageSimilarity(newImageUrl, existingImageUrl);
    
    // 4. TEMPORAL ANALYSIS
    const temporalAnalysis = analyzeTemporalRelevance(existingComplaint.createdAt);
    
    // 5. COMPLAINT TYPE ANALYSIS
    const typeAnalysis = await analyzeComplaintType(newComplaint, existingComplaint);

    // WEIGHTED SCORING SYSTEM
    const weights = {
      semantic: 0.35,    // 35% - Text similarity
      location: 0.30,    // 30% - Location proximity
      image: 0.20,       // 20% - Image similarity
      temporal: 0.10,    // 10% - Time relevance
      type: 0.05         // 5% - Complaint type
    };

    const finalScore = 
      (semanticAnalysis.score * weights.semantic) +
      (locationAnalysis.score * weights.location) +
      (imageAnalysis.score * weights.image) +
      (temporalAnalysis.score * weights.temporal) +
      (typeAnalysis.score * weights.type);

    // DETAILED EXPLANATION
    const explanation = generateDuplicateExplanation({
      semantic: semanticAnalysis,
      location: locationAnalysis,
      image: imageAnalysis,
      temporal: temporalAnalysis,
      type: typeAnalysis,
      finalScore
    });

    // DUPLICATE DECISION LOGIC
    const isDuplicate = decideDuplicateStatus(finalScore, {
      semantic: semanticAnalysis,
      location: locationAnalysis,
      image: imageAnalysis
    });

    logger.ai('✅ Enhanced similarity analysis completed', {
      finalScore: finalScore.toFixed(3),
      isDuplicate,
      semanticScore: semanticAnalysis.score,
      locationScore: locationAnalysis.score,
      imageScore: imageAnalysis.score
    });
    
    return {
      score: finalScore,
      isDuplicate,
      explanation,
      breakdown: {
        semantic: semanticAnalysis,
        location: locationAnalysis,
        image: imageAnalysis,
        temporal: temporalAnalysis,
        type: typeAnalysis
      },
      confidence: calculateConfidence(finalScore, semanticAnalysis, locationAnalysis, imageAnalysis)
    };

  } catch (error) {
    logger.critical('💥 Error in enhanced similarity analysis', {
      error: error.message,
      stack: error.stack
    });
    
    return {
      score: 0,
      isDuplicate: false,
      explanation: 'Error in similarity analysis - treating as unique',
      breakdown: {},
      confidence: 0
    };
  }
}



/**
 * Analyze semantic similarity between complaint texts
 */
async function analyzeSemanticSimilarity(newComplaint, existingComplaint) {
  try {
    const completion = await openai.chat.completions.create({
      model: AI_CONFIG.model,
      messages: [
        {
          role: 'system',
          content: `You are analyzing similarity between municipal complaints. Focus on:

1. Core problem described (water, roads, waste, etc.)
2. Specific issue details (leak, pothole, overflow, etc.)
3. Severity/urgency indicators
4. Infrastructure mentioned (pipes, street names, facilities)

IMPORTANT: Different photos of the same issue OR different descriptions of the same problem should score HIGH similarity.

Return ONLY a JSON object:
{
  "score": 0.0-1.0,
  "reasoning": "brief explanation",
  "problem_match": boolean,
  "severity_match": boolean,
  "infrastructure_match": boolean
}`
        },
        {
          role: 'user',
          content: `NEW COMPLAINT: "${newComplaint}"\n\nEXISTING COMPLAINT: "${existingComplaint}"`
        }
      ],
      max_tokens: 200,
      temperature: 0.2,
    });

    const response = completion.choices[0].message.content.trim();
    const analysis = JSON.parse(response.replace(/```json|```/g, ''));
    
    return {
      score: analysis.score || 0,
      reasoning: analysis.reasoning || 'No reasoning provided',
      problemMatch: analysis.problem_match || false,
      severityMatch: analysis.severity_match || false,
      infrastructureMatch: analysis.infrastructure_match || false
    };
  } catch (error) {
    logger.warning('⚠️ Error in semantic analysis', { error: error.message });
    return { score: 0, reasoning: 'Analysis failed', problemMatch: false, severityMatch: false, infrastructureMatch: false };
  }
}

/**
 * Analyze location proximity between complaints
 */
async function analyzeLocationProximity(newLocation, existingLocation) {
  try {
    if (!newLocation || !existingLocation) {
      return {
        score: 0,
        distance: null,
        reasoning: 'One or both locations missing',
        withinProximity: false
      };
    }

    // Calculate distance between coordinates
    const distance = calculateDistance(
      newLocation.latitude, newLocation.longitude,
      existingLocation.latitude, existingLocation.longitude
    );

    // Address similarity check
    const addressSimilarity = calculateAddressSimilarity(
      newLocation.address || '',
      existingLocation.address || ''
    );

    // Proximity scoring based on distance and address
    let score = 0;
    let reasoning = '';
    let withinProximity = false;

    if (distance <= 0.05) { // Within 50 meters
      score = 0.95;
      reasoning = `Very close proximity: ${Math.round(distance * 1000)}m apart`;
      withinProximity = true;
    } else if (distance <= 0.1) { // Within 100 meters
      score = 0.85;
      reasoning = `Close proximity: ${Math.round(distance * 1000)}m apart`;
      withinProximity = true;
    } else if (distance <= 0.2) { // Within 200 meters
      score = 0.7;
      reasoning = `Nearby: ${Math.round(distance * 1000)}m apart`;
      withinProximity = true;
    } else if (distance <= 0.5) { // Within 500 meters
      score = 0.4;
      reasoning = `Same area: ${Math.round(distance * 1000)}m apart`;
    } else if (distance <= 1.0) { // Within 1km
      score = 0.2;
      reasoning = `Same locality: ${distance.toFixed(2)}km apart`;
    } else {
      score = 0;
      reasoning = `Different areas: ${distance.toFixed(2)}km apart`;
    }

    // Boost score if addresses are very similar
    if (addressSimilarity > 0.8) {
      score = Math.min(1.0, score + 0.2);
      reasoning += ' + similar addresses';
    }

    return {
      score,
      distance,
      reasoning,
      withinProximity,
      addressSimilarity
    };

  } catch (error) {
    logger.warning('⚠️ Error in location analysis', { error: error.message });
    return { score: 0, distance: null, reasoning: 'Location analysis failed', withinProximity: false };
  }
}

/**
 * Analyze image similarity (if both complaints have images)
 */
async function analyzeImageSimilarity(newImageUrl, existingImageUrl) {
  try {
    if (!newImageUrl || !existingImageUrl) {
      return {
        score: 0,
        reasoning: 'One or both images missing',
        visualMatch: false
      };
    }

    // Use GPT-4o-mini Vision to compare images
    const completion = await openai.chat.completions.create({
      model: AI_CONFIG.model,
      messages: [
        {
          role: 'system',
          content: `Compare these two images for municipal complaint similarity. Consider:

1. Same infrastructure/location from different angles
2. Same type of problem (pothole, leak, garbage, etc.)
3. Same or adjacent areas
4. Same time of day/lighting conditions

IMPORTANT: Same location photographed from different angles or at different times should score HIGH similarity.

Return ONLY JSON:
{
  "score": 0.0-1.0,
  "reasoning": "brief explanation",
  "same_location": boolean,
  "same_problem": boolean,
  "visual_match": boolean
}`
        },
        {
          role: 'user',
          content: [
            { type: 'text', text: 'NEW COMPLAINT IMAGE:' },
            { type: 'image_url', image_url: { url: newImageUrl } },
            { type: 'text', text: 'EXISTING COMPLAINT IMAGE:' },
            { type: 'image_url', image_url: { url: existingImageUrl } }
          ]
        }
      ],
      max_tokens: 200,
      temperature: 0.2,
    });

    const response = completion.choices[0].message.content.trim();
    const analysis = JSON.parse(response.replace(/```json|```/g, ''));
    
    return {
      score: analysis.score || 0,
      reasoning: analysis.reasoning || 'No reasoning provided',
      sameLocation: analysis.same_location || false,
      sameProblem: analysis.same_problem || false,
      visualMatch: analysis.visual_match || false
    };

  } catch (error) {
    logger.warning('⚠️ Error in image analysis', { error: error.message });
    return { score: 0, reasoning: 'Image analysis failed', visualMatch: false };
  }
}

/**
 * Analyze temporal relevance
 */
function analyzeTemporalRelevance(existingComplaintDate) {
  try {
    const now = new Date();
    const existingDate = existingComplaintDate?.toDate ? existingComplaintDate.toDate() : new Date(existingComplaintDate);
    const hoursDiff = (now - existingDate) / (1000 * 60 * 60);

    let score = 0;
    let reasoning = '';

    if (hoursDiff <= 24) {
      score = 1.0;
      reasoning = 'Same day complaint';
    } else if (hoursDiff <= 72) {
      score = 0.8;
      reasoning = 'Within 3 days';
    } else if (hoursDiff <= 168) {
      score = 0.6;
      reasoning = 'Within 1 week';
    } else if (hoursDiff <= 720) {
      score = 0.3;
      reasoning = 'Within 1 month';
    } else {
      score = 0.1;
      reasoning = 'Old complaint';
    }

    return { score, reasoning, hoursDiff };
  } catch (error) {
    return { score: 0.5, reasoning: 'Date analysis failed', hoursDiff: null };
  }
}

/**
 * Analyze complaint type similarity
 */
async function analyzeComplaintType(newComplaint, existingComplaint) {
  try {
    const completion = await openai.chat.completions.create({
      model: AI_CONFIG.model,
      messages: [
        {
          role: 'system',
          content: `Determine if these complaints are about the same TYPE of municipal issue:

Types: water_supply, drainage, roads, street_lights, waste_management, building_permits, property_tax, health_sanitation, parks, traffic

Return ONLY JSON:
{
  "score": 0.0-1.0,
  "same_type": boolean,
  "new_type": "category",
  "existing_type": "category"
}`
        },
        {
          role: 'user',
          content: `NEW: "${newComplaint}"\nEXISTING: "${existingComplaint}"`
        }
      ],
      max_tokens: 100,
      temperature: 0.1,
    });

    const response = completion.choices[0].message.content.trim();
    const analysis = JSON.parse(response.replace(/```json|```/g, ''));
    
    return {
      score: analysis.score || 0,
      sameType: analysis.same_type || false,
      newType: analysis.new_type || 'unknown',
      existingType: analysis.existing_type || 'unknown'
    };

  } catch (error) {
    logger.warning('⚠️ Error in type analysis', { error: error.message });
    return { score: 0, sameType: false, newType: 'unknown', existingType: 'unknown' };
  }
}

/**
 * Calculate distance between two coordinates using Haversine formula
 */
function calculateDistance(lat1, lon1, lat2, lon2) {
  const R = 6371; // Earth's radius in kilometers
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLon = (lon2 - lon1) * Math.PI / 180;
  const a = 
    Math.sin(dLat/2) * Math.sin(dLat/2) +
    Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) * 
    Math.sin(dLon/2) * Math.sin(dLon/2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
  return R * c; // Distance in kilometers
}

/**
 * Calculate address similarity
 */
function calculateAddressSimilarity(address1, address2) {
  if (!address1 || !address2) return 0;
  
  const normalize = (str) => str.toLowerCase().replace(/[^a-z0-9\s]/g, '').trim();
  const norm1 = normalize(address1);
  const norm2 = normalize(address2);
  
  if (norm1 === norm2) return 1;
  
  const words1 = norm1.split(/\s+/);
  const words2 = norm2.split(/\s+/);
  
  const intersection = words1.filter(word => words2.includes(word));
  const union = [...new Set([...words1, ...words2])];
  
  return intersection.length / union.length;
}

/**
 * Generate detailed explanation for duplicate decision
 */
function generateDuplicateExplanation(analysis) {
  const { semantic, location, image, temporal, type, finalScore } = analysis;
  
  let explanation = `Similarity Analysis (Score: ${(finalScore * 100).toFixed(1)}%):\n\n`;
  
  explanation += `📝 Text: ${(semantic.score * 100).toFixed(1)}% - ${semantic.reasoning}\n`;
  explanation += `📍 Location: ${(location.score * 100).toFixed(1)}% - ${location.reasoning}\n`;
  
  if (image.score > 0) {
    explanation += `🖼️ Images: ${(image.score * 100).toFixed(1)}% - ${image.reasoning}\n`;
  }
  
  explanation += `⏰ Timing: ${(temporal.score * 100).toFixed(1)}% - ${temporal.reasoning}\n`;
  explanation += `🏷️ Type: ${(type.score * 100).toFixed(1)}% - Same category: ${type.sameType}\n`;
  
  return explanation;
}

/**
 * Advanced duplicate decision logic
 */
function decideDuplicateStatus(finalScore, { semantic, location, image }) {
  // High confidence duplicate
  if (finalScore >= 0.85) return true;
  
  // Medium-high score with strong location match
  if (finalScore >= 0.75 && location.withinProximity) return true;
  
  // High semantic similarity with close location
  if (semantic.score >= 0.85 && location.score >= 0.7) return true;
  
  // Perfect location match with decent semantic similarity
  if (location.score >= 0.9 && semantic.score >= 0.6) return true;
  
  // Strong image match with good location
  if (image.score >= 0.8 && location.score >= 0.6) return true;
  
  // Conservative threshold for general cases
  return finalScore >= 0.8;
}

/**
 * Calculate confidence level for duplicate decision
 */
function calculateConfidence(finalScore, semantic, location, image) {
  let confidence = finalScore;
  
  // Boost confidence for multiple strong indicators
  const strongIndicators = [
    semantic.score >= 0.8,
    location.withinProximity,
    image.score >= 0.7
  ].filter(Boolean).length;
  
  if (strongIndicators >= 2) {
    confidence = Math.min(1.0, confidence + 0.1);
  }
  
  return confidence;
}




/*
 * FEATURE 1: Check if message is a complaint status query
 */
function isComplaintStatusQuery(messageText) {
  const text = messageText.toLowerCase().trim();
  
  // English patterns
  const englishPatterns = [
    'my complaints',
    'my complaint',
    'complaint status',
    'check complaint',
    'complaint history',
    'my tickets',
    'my ticket',
    'ticket status',
    'show complaints',
    'view complaints',
    'list complaints'
  ];
  
  // Marathi patterns
  const marathiPatterns = [
    'माझ्या तक्रारी',
    'माझी तक्रार',
    'तक्रार स्थिती',
    'तक्रारीची स्थिती',
    'माझे तिकीट',
    'माझी तिकीट',
    'तिकीट स्थिती',
    'तक्रार पहा',
    'तक्रारी दाखवा'
  ];
  
  // Check English patterns
  for (const pattern of englishPatterns) {
    if (text.includes(pattern)) {
      return true;
    }
  }
  
  // Check Marathi patterns
  for (const pattern of marathiPatterns) {
    if (text.includes(pattern)) {
      return true;
    }
  }
  
  return false;
}

/*
 * Calculate ethical score for message content
 */
async function calculateEthicalScore(messageText) {
  try {
    logger.ai('📊 Calculating ethical score', {
      messageLength: messageText.length
    });

    const completion = await openai.chat.completions.create({
      model: AI_CONFIG.model,
      messages: [
        {
          role: 'system',
          content: `Rate the ethical/appropriateness score of this message on a scale of 1-10:

SCORING CRITERIA:
1-3: Inappropriate, offensive, abusive, threatening
4-5: Potentially problematic, rude, unprofessional
6-7: Neutral, acceptable but could be better
8-9: Respectful, appropriate, constructive
10: Exemplary, very respectful, helpful

Consider:
- Language tone and politeness
- Respect for public servants
- Constructive vs destructive criticism
- Appropriate complaint language
- Cultural sensitivity

Return ONLY a single number between 1 and 10.`
        },
        {
          role: 'user',
          content: `Message: "${messageText}"`
        }
      ],
      max_tokens: 5,
      temperature: 0.1,
    });

    const response = completion.choices[0].message.content.trim();
    const score = parseInt(response.replace(/[^0-9]/g, ''));
    const finalScore = isNaN(score) ? 7 : Math.max(1, Math.min(10, score));
    
    logger.ai(`📊 Ethical score calculated: ${finalScore}/10`);
    return finalScore;
  } catch (error) {
    logger.warning('⚠️ Error calculating ethical score', {
      error: error.message
    });
    return 7; // Default neutral score
  }
}

/*
 * Categorize department based on complaint description
 */
async function categorizeDepartment(description) {
  try {
    const completion = await openai.chat.completions.create({
      model: AI_CONFIG.model,
      messages: [
        {
          role: 'system',
          content: `Categorize this municipal complaint into the most appropriate PCMC department:

AVAILABLE DEPARTMENTS:
- Water Supply
- Waste Management
- Roads & Infrastructure
- Health & Sanitation
- Building & Planning
- Electricity
- Parks & Recreation
- Traffic & Transport
- Property Tax
- General Administration

CATEGORIZATION RULES:
- Water issues → Water Supply
- Garbage/cleaning → Waste Management
- Road/streetlight → Roads & Infrastructure
- Medical/hygiene → Health & Sanitation
- Construction/permits → Building & Planning
- Power/electricity → Electricity
- Garden/playground → Parks & Recreation
- Traffic/parking → Traffic & Transport
- Tax/billing → Property Tax
- Other/unclear → General Administration

Return ONLY the department name exactly as listed above.`
        },
        {
          role: 'user',
          content: `Complaint: "${description}"`
        }
      ],
      max_tokens: 20,
      temperature: 0.3,
    });

    const response = completion.choices[0].message.content.trim();
    
    // Validate response
    const validDepartments = [
      'Water Supply', 'Waste Management', 'Roads & Infrastructure',
      'Health & Sanitation', 'Building & Planning', 'Electricity',
      'Parks & Recreation', 'Traffic & Transport', 'Property Tax',
      'General Administration'
    ];
    
    const department = validDepartments.includes(response) ? response : 'General Administration';
    
    logger.ai('🏛️ Department categorized', {
      department,
      descriptionPreview: description.substring(0, 50) + '...'
    });
    
    return department;
  } catch (error) {
    logger.warning('⚠️ Error categorizing department', {
      error: error.message
    });
    return 'General Administration';
  }
}

/*
 * Assess complaint priority level
 */
async function assessComplaintPriority(description) {
  try {
    const completion = await openai.chat.completions.create({
      model: AI_CONFIG.model,
      messages: [
        {
          role: 'system',
          content: `Assess the priority level of this municipal complaint:

PRIORITY LEVELS:
- emergency: Life-threatening, safety hazards, major service disruption
- high: Significant inconvenience, health risks, urgent repairs needed
- medium: Standard complaints, routine maintenance, general issues
- low: Minor inconveniences, cosmetic issues, suggestions

PRIORITY INDICATORS:
Emergency: water contamination, major road collapse, fire safety, medical emergencies
High: no water supply, major leaks, traffic hazards, waste overflow
Medium: poor water pressure, minor road issues, delayed garbage collection
Low: cosmetic damages, minor repairs, general suggestions

Return ONLY one word: emergency, high, medium, or low`
        },
        {
          role: 'user',
          content: `Complaint: "${description}"`
        }
      ],
      max_tokens: 10,
      temperature: 0.3,
    });

    const response = completion.choices[0].message.content.trim().toLowerCase();
    const validPriorities = ['emergency', 'high', 'medium', 'low'];
    const priority = validPriorities.includes(response) ? response : 'medium';
    
    logger.ai('⚡ Priority assessed', {
      priority,
      descriptionPreview: description.substring(0, 50) + '...'
    });
    
    return priority;
  } catch (error) {
    logger.warning('⚠️ Error assessing priority', {
      error: error.message
    });
    return 'medium';
  }
}

/*
 * Categorize complaint type
 */
async function categorizeComplaintType(description) {
  try {
    const completion = await openai.chat.completions.create({
      model: AI_CONFIG.model,
      messages: [
        {
          role: 'system',
          content: `Categorize this complaint into a specific type:

COMPLAINT TYPES:
- Water Supply Issues
- Drainage Problems
- Road Maintenance
- Street Lighting
- Waste Collection
- Public Toilets
- Building Permits
- Property Tax
- Traffic Management
- Park Maintenance
- Health Services
- General Services

Return ONLY the complaint type from the list above.`
        },
        {
          role: 'user',
          content: `Complaint: "${description}"`
        }
      ],
      max_tokens: 20,
      temperature: 0.3,
    });

    const response = completion.choices[0].message.content.trim();
    
    const validTypes = [
      'Water Supply Issues', 'Drainage Problems', 'Road Maintenance',
      'Street Lighting', 'Waste Collection', 'Public Toilets',
      'Building Permits', 'Property Tax', 'Traffic Management',
      'Park Maintenance', 'Health Services', 'General Services'
    ];
    
    const type = validTypes.includes(response) ? response : 'General Services';
    
    logger.ai('📊 Complaint type categorized', {
      type,
      descriptionPreview: description.substring(0, 50) + '...'
    });
    
    return type;
  } catch (error) {
    logger.warning('⚠️ Error categorizing complaint type', {
      error: error.message
    });
    return 'General Services';
  }
}

/*
 * Transcribe audio using Whisper
 */
async function transcribeAudio(audioPath) {
  try {
    logger.ai('🎙️ Transcribing audio with Whisper');
    
    const transcription = await openai.audio.transcriptions.create({
      file: require('fs').createReadStream(audioPath),
      model: 'whisper-1',
      language: 'en', // Support Hindi/Marathi
    });
    
    logger.ai('✅ Audio transcription completed', {
      transcriptLength: transcription.text.length
    });
    
    return transcription.text;
  } catch (error) {
    logger.critical('💥 Error transcribing audio', {
      error: error.message,
      audioPath
    });
    return 'Could not transcribe audio';
  }
}

/*
 * Analyze image content
 */
async function analyzeImageContent(imageUrl) {
  try {
    logger.ai('🖼️ Analyzing image content with GPT-4o-mini');
    
    const completion = await openai.chat.completions.create({
      model: AI_CONFIG.model,
      messages: [
        {
          role: 'user',
          content: [
            {
              type: 'text',
              text: 'Analyze this image for any municipal issues, problems, or infrastructure concerns. Describe what you see and identify any issues that might need PCMC attention. Keep response concise and actionable.'
            },
            {
              type: 'image_url',
              image_url: { url: imageUrl }
            }
          ]
        }
      ],
      max_tokens: 300,
    });

    const analysis = completion.choices[0].message.content;
    
    logger.ai('✅ Image analysis completed', {
      analysisLength: analysis.length,
      imageUrl: imageUrl.substring(0, 50) + '...'
    });
    
    return analysis;
  } catch (error) {
    logger.critical('💥 Error analyzing image', {
      error: error.message,
      imageUrl: imageUrl.substring(0, 50) + '...'
    });
    return 'Could not analyze image content';
  }
}

/*
 * Detect language of text
 */
function detectLanguage(text) {
  if (!text || typeof text !== 'string') {
    return 'english';
  }
  
  // Check for Devanagari script (Marathi/Hindi)
  if (containsDevanagari(text)) {
    return 'marathi';
  }
  
  // Check for common Marathi words in Roman script
  const marathiRomanWords = ['ahe', 'aahe', 'kay', 'kasa', 'kuthe', 'kiti', 'pan', 'ani', 'tar'];
  const lowerText = text.toLowerCase();
  
  for (const word of marathiRomanWords) {
    if (lowerText.includes(word)) {
      return 'marathi';
    }
  }
  
  return 'english';
}

/*
 * Create system prompt based on intent and language
 */
function createSystemPrompt(intentAnalysis, language) {
  const basePrompt = `You are the official PCMC (Pimpri-Chinchwad Municipal Corporation) AI Assistant. You are helpful, professional, and represent the municipal corporation with dignity.

IMPORTANT INSTRUCTIONS:
1. Always respond in ${language === 'marathi' ? 'Marathi' : 'English'} language
2. Be respectful, professional, and use appropriate WhatsApp-style emojis
3. Keep responses concise and WhatsApp-friendly (under 300 words)
4. Use proper formatting with *bold* text for headings
5. Always end with "🏛️ *PCMC सेवा*" or "🏛️ *PCMC Service*"

PCMC SERVICES:
- Water Supply & Distribution
- Waste Management & Sanitation
- Roads & Infrastructure
- Health Services
- Building Permits & Planning
- Property Tax
- Parks & Recreation
- Traffic Management

CURRENT CONTEXT:
- User Intent: ${intentAnalysis.intent}
- Conversation Context: ${intentAnalysis.context}
- Conversation State: ${intentAnalysis.state}

RESPONSE GUIDELINES:
- For complaints: Be empathetic, ask for location if needed
- For queries: Provide accurate PCMC information
- For status requests: Guide to proper channels
- For general chat: Be friendly but redirect to PCMC services

Always maintain professional standards and represent PCMC positively.`;

  return basePrompt;
}

/*
 * Check if AI response requires location
 */
async function checkIfLocationRequired(userMessage, aiResponse) {
  try {
    // Simple heuristic: if response mentions location, address, or asks where
    const locationKeywords = [
      'location', 'address', 'where', 'स्थान', 'पत्ता', 'कुठे',
      'exact location', 'specific address', 'share location'
    ];
    
    const combinedText = (userMessage + ' ' + aiResponse).toLowerCase();
    
    return locationKeywords.some(keyword => combinedText.includes(keyword));
  } catch (error) {
    logger.warning('⚠️ Error checking location requirement', {
      error: error.message
    });
    return false;
  }
}

/*
 * Get location prompt based on language
 */
function getLocationPrompt(language) {
  return language === 'marathi' 
    ? '📍 कृपया तुमचे अचूक स्थान शेअर करा जेणेकरून आम्ही तुमची मदत करू शकू.'
    : '📍 Please share your exact location so we can assist you better.';
}

// Export all functions
module.exports = {
  processMessageWithAI,
  analyzeIntent,
  checkComplaintSimilarity,     // FEATURE 2: Duplicate detection
  isComplaintStatusQuery,       // FEATURE 1: Status query detection
  calculateEthicalScore,
  categorizeDepartment,
  assessComplaintPriority,
  categorizeComplaintType,
  transcribeAudio,
  analyzeImageContent,
  detectLanguage,
  createSystemPrompt,
  checkIfLocationRequired,
  getLocationPrompt,
  
  // Constants
  AI_CONFIG
};