// utils/helpers.js - Comprehensive utility functions for PCMC WhatsApp Bot
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

/**
 * Generate random string of specified length
 * @param {number} length - Length of the string to generate
 * @param {string} charset - Character set to use (default: alphanumeric)
 * @returns {string} Random string
 */
function generateRandomString(length = 8, charset = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789') {
  let result = '';
  const charactersLength = charset.length;
  
  for (let i = 0; i < length; i++) {
    result += charset.charAt(Math.floor(Math.random() * charactersLength));
  }
  
  return result;
}

/**
 * Generate ticket ID with specific format for PCMC
 * @param {number} length - Length of the ticket ID
 * @param {string} prefix - Optional prefix (default: 'PCMC')
 * @returns {string} Formatted ticket ID
 */
function generateTicketId(length = 8, prefix = '') {
  const timestamp = Date.now().toString(36).toUpperCase(); // Base36 timestamp
  const randomPart = generateRandomString(length - timestamp.length, '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ');
  
  const ticketId = timestamp + randomPart;
  
  return prefix ? `${prefix}-${ticketId}` : ticketId;
}

/**
 * Generate unique complaint ID with date prefix
 * @returns {string} Formatted complaint ID
 */
function generateComplaintId() {
  const date = new Date();
  const dateStr = date.getFullYear().toString() + 
                  (date.getMonth() + 1).toString().padStart(2, '0') + 
                  date.getDate().toString().padStart(2, '0');
  
  const randomPart = generateRandomString(6, '0123456789ABCDEF');
  return `PCMC-${dateStr}-${randomPart}`;
}

/**
 * Format phone number to standard format
 * @param {string} phoneNumber - Raw phone number
 * @returns {string} Formatted phone number
 */
function formatPhoneNumber(phoneNumber) {
  if (!phoneNumber || typeof phoneNumber !== 'string') {
    return '';
  }
  
  // Remove any non-digit characters
  const cleaned = phoneNumber.replace(/\D/g, '');
  
  // Handle different formats
  if (cleaned.length === 10) {
    // Indian mobile number without country code
    return `91${cleaned}`;
  } else if (cleaned.length === 12 && cleaned.startsWith('91')) {
    // Indian mobile number with country code
    return cleaned;
  } else if (cleaned.length === 13 && cleaned.startsWith('911')) {
    // Malformed with extra 1
    return cleaned.substring(1);
  }
  
  // Return as-is if format is unknown but seems valid
  if (cleaned.length >= 10 && cleaned.length <= 15) {
    return cleaned;
  }
  
  return phoneNumber; // Return original if can't format
}

/**
 * Validate phone number format
 * @param {string} phoneNumber - Phone number to validate
 * @returns {boolean} True if valid
 */
function isValidPhoneNumber(phoneNumber) {
  if (!phoneNumber || typeof phoneNumber !== 'string') {
    return false;
  }
  
  const cleaned = phoneNumber.replace(/\D/g, '');
  
  // Check for valid Indian mobile number
  if (cleaned.length === 12 && cleaned.startsWith('91')) {
    const mobileNumber = cleaned.substring(2);
    // Indian mobile numbers start with 6, 7, 8, or 9
    return /^[6-9]\d{9}$/.test(mobileNumber);
  }
  
  // Check for 10-digit Indian mobile
  if (cleaned.length === 10) {
    return /^[6-9]\d{9}$/.test(cleaned);
  }
  
  // General international format
  return cleaned.length >= 10 && cleaned.length <= 15;
}

/**
 * Sanitize input text to prevent injection attacks
 * @param {string} input - Input text to sanitize
 * @param {number} maxLength - Maximum allowed length (default: 5000)
 * @returns {string} Sanitized text
 */
function sanitizeInput(input, maxLength = 5000) {
  if (!input || typeof input !== 'string') {
    return '';
  }
  
  // Remove potentially harmful characters while preserving emojis and Devanagari
  let sanitized = input
    .replace(/[<>\"'`]/g, '') // Remove HTML/script characters
    .replace(/javascript:/gi, '') // Remove javascript: protocol
    .replace(/on\w+\s*=/gi, '') // Remove event handlers
    .trim();
  
  // Limit length
  if (sanitized.length > maxLength) {
    sanitized = sanitized.substring(0, maxLength);
  }
  
  return sanitized;
}

/**
 * Get current timestamp in various formats
 * @param {string} format - Format type ('iso', 'unix', 'readable', 'filename')
 * @returns {string|number} Formatted timestamp
 */
function getCurrentTimestamp(format = 'iso') {
  const now = new Date();
  
  switch (format) {
    case 'iso':
      return now.toISOString();
    case 'unix':
      return Math.floor(now.getTime() / 1000);
    case 'readable':
      return now.toLocaleString('en-IN', {
        timeZone: 'Asia/Kolkata',
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit'
      });
    case 'filename':
      return now.toISOString().replace(/[:.]/g, '-').slice(0, -5);
    default:
      return now.toISOString();
  }
}

/**
 * Format timestamp for display
 * @param {Date|string|number} timestamp - Timestamp to format
 * @param {string} locale - Locale for formatting (default: 'en-IN')
 * @returns {string} Formatted timestamp
 */
function formatTimestamp(timestamp, locale = 'en-IN') {
  try {
    let date;
    
    if (timestamp instanceof Date) {
      date = timestamp;
    } else if (typeof timestamp === 'string') {
      date = new Date(timestamp);
    } else if (typeof timestamp === 'number') {
      // Handle both seconds and milliseconds
      date = new Date(timestamp < 1e12 ? timestamp * 1000 : timestamp);
    } else if (timestamp && typeof timestamp.toDate === 'function') {
      // Firestore timestamp
      date = timestamp.toDate();
    } else {
      return 'Invalid Date';
    }
    
    if (isNaN(date.getTime())) {
      return 'Invalid Date';
    }
    
    return date.toLocaleString(locale, {
      timeZone: 'Asia/Kolkata',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit'
    });
  } catch (error) {
    return 'Invalid Date';
  }
}

/**
 * Calculate time difference in human-readable format
 * @param {Date|string} startTime - Start time
 * @param {Date|string} endTime - End time (default: now)
 * @returns {string} Human-readable time difference
 */
function getTimeDifference(startTime, endTime = new Date()) {
  try {
    const start = new Date(startTime);
    const end = new Date(endTime);
    const diffMs = end - start;
    
    if (diffMs < 0) {
      return 'In the future';
    }
    
    const diffSeconds = Math.floor(diffMs / 1000);
    const diffMinutes = Math.floor(diffSeconds / 60);
    const diffHours = Math.floor(diffMinutes / 60);
    const diffDays = Math.floor(diffHours / 24);
    
    if (diffDays > 0) {
      return `${diffDays} day${diffDays > 1 ? 's' : ''} ago`;
    } else if (diffHours > 0) {
      return `${diffHours} hour${diffHours > 1 ? 's' : ''} ago`;
    } else if (diffMinutes > 0) {
      return `${diffMinutes} minute${diffMinutes > 1 ? 's' : ''} ago`;
    } else {
      return `${diffSeconds} second${diffSeconds > 1 ? 's' : ''} ago`;
    }
  } catch (error) {
    return 'Unknown';
  }
}

/**
 * Extract emojis from text
 * @param {string} text - Text to extract emojis from
 * @returns {Array} Array of emojis found
 */
function extractEmojis(text) {
  if (!text || typeof text !== 'string') {
    return [];
  }
  
  // Enhanced emoji regex pattern
  const emojiRegex = /[\u{1F600}-\u{1F64F}]|[\u{1F300}-\u{1F5FF}]|[\u{1F680}-\u{1F6FF}]|[\u{1F1E0}-\u{1F1FF}]|[\u{2600}-\u{26FF}]|[\u{2700}-\u{27BF}]|[\u{1F900}-\u{1F9FF}]|[\u{1F018}-\u{1F270}]/gu;
  
  const matches = text.match(emojiRegex);
  return matches || [];
}

/**
 * Count words in text (supports multiple languages)
 * @param {string} text - Text to count words in
 * @returns {number} Word count
 */
function wordCount(text) {
  if (!text || typeof text !== 'string') {
    return 0;
  }
  
  // Handle both English and Devanagari text
  const cleaned = text.trim().replace(/\s+/g, ' ');
  
  if (cleaned === '') {
    return 0;
  }
  
  // Split by spaces and filter out empty strings
  const words = cleaned.split(' ').filter(word => word.length > 0);
  return words.length;
}

/**
 * Truncate text with ellipsis
 * @param {string} text - Text to truncate
 * @param {number} maxLength - Maximum length (default: 100)
 * @param {string} suffix - Suffix to add (default: '...')
 * @returns {string} Truncated text
 */
function truncateText(text, maxLength = 100, suffix = '...') {
  if (!text || typeof text !== 'string') {
    return '';
  }
  
  if (text.length <= maxLength) {
    return text;
  }
  
  return text.substring(0, maxLength - suffix.length) + suffix;
}

/**
 * Convert text to title case
 * @param {string} text - Text to convert
 * @returns {string} Title case text
 */
function toTitleCase(text) {
  if (!text || typeof text !== 'string') {
    return '';
  }
  
  return text.toLowerCase().replace(/\b\w/g, l => l.toUpperCase());
}

/**
 * Generate hash of a string (for duplicate detection)
 * @param {string} text - Text to hash
 * @param {string} algorithm - Hash algorithm (default: 'sha256')
 * @returns {string} Hash string
 */
function generateHash(text, algorithm = 'sha256') {
  if (!text || typeof text !== 'string') {
    return '';
  }
  
  return crypto.createHash(algorithm).update(text).digest('hex');
}

/**
 * Check if text contains Marathi/Devanagari script
 * @param {string} text - Text to check
 * @returns {boolean} True if contains Devanagari
 */
function containsDevanagari(text) {
  if (!text || typeof text !== 'string') {
    return false;
  }
  
  const devanagariRegex = /[\u0900-\u097F]/;
  return devanagariRegex.test(text);
}

/**
 * Extract numbers from text
 * @param {string} text - Text to extract numbers from
 * @returns {Array} Array of numbers found
 */
function extractNumbers(text) {
  if (!text || typeof text !== 'string') {
    return [];
  }
  
  const numberRegex = /\d+(?:\.\d+)?/g;
  const matches = text.match(numberRegex);
  return matches ? matches.map(num => parseFloat(num)) : [];
}

/**
 * Validate email address
 * @param {string} email - Email to validate
 * @returns {boolean} True if valid email
 */
function isValidEmail(email) {
  if (!email || typeof email !== 'string') {
    return false;
  }
  
  const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  return emailRegex.test(email);
}

/**
 * Generate UUID v4
 * @returns {string} UUID string
 */
function generateUUID() {
  return crypto.randomUUID();
}

/**
 * Sleep/delay function
 * @param {number} ms - Milliseconds to sleep
 * @returns {Promise} Promise that resolves after delay
 */
function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Retry function with exponential backoff
 * @param {Function} fn - Function to retry
 * @param {number} maxRetries - Maximum number of retries
 * @param {number} baseDelay - Base delay in milliseconds
 * @returns {Promise} Promise that resolves with function result
 */
async function retryWithBackoff(fn, maxRetries = 3, baseDelay = 1000) {
  let lastError;
  
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await fn();
    } catch (error) {
      lastError = error;
      
      if (attempt === maxRetries) {
        throw lastError;
      }
      
      const delay = baseDelay * Math.pow(2, attempt);
      await sleep(delay);
    }
  }
}

/**
 * Format file size in human-readable format
 * @param {number} bytes - Size in bytes
 * @param {number} decimals - Number of decimal places
 * @returns {string} Formatted file size
 */
function formatFileSize(bytes, decimals = 2) {
  if (bytes === 0) return '0 Bytes';
  
  const k = 1024;
  const dm = decimals < 0 ? 0 : decimals;
  const sizes = ['Bytes', 'KB', 'MB', 'GB', 'TB'];
  
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  
  return parseFloat((bytes / Math.pow(k, i)).toFixed(dm)) + ' ' + sizes[i];
}

/**
 * Deep clone object (JSON safe)
 * @param {Object} obj - Object to clone
 * @returns {Object} Cloned object
 */
function deepClone(obj) {
  if (obj === null || typeof obj !== 'object') {
    return obj;
  }
  
  try {
    return JSON.parse(JSON.stringify(obj));
  } catch (error) {
    // Fallback for non-JSON serializable objects
    return Object.assign({}, obj);
  }
}

/**
 * Check if object is empty
 * @param {Object} obj - Object to check
 * @returns {boolean} True if empty
 */
function isEmpty(obj) {
  if (obj == null) return true;
  if (typeof obj === 'string' || Array.isArray(obj)) return obj.length === 0;
  if (typeof obj === 'object') return Object.keys(obj).length === 0;
  return false;
}

/**
 * Get file extension from filename
 * @param {string} filename - Filename to extract extension from
 * @returns {string} File extension (without dot)
 */
function getFileExtension(filename) {
  if (!filename || typeof filename !== 'string') {
    return '';
  }
  
  const lastDot = filename.lastIndexOf('.');
  return lastDot === -1 ? '' : filename.substring(lastDot + 1).toLowerCase();
}

/**
 * Create safe filename from text
 * @param {string} text - Text to convert to filename
 * @param {number} maxLength - Maximum filename length
 * @returns {string} Safe filename
 */
function createSafeFilename(text, maxLength = 50) {
  if (!text || typeof text !== 'string') {
    return 'unnamed';
  }
  
  // Remove unsafe characters and replace with underscores
  let safe = text
    .replace(/[<>:"/\\|?*]/g, '_')
    .replace(/\s+/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_|_$/g, '');
  
  // Truncate if too long
  if (safe.length > maxLength) {
    safe = safe.substring(0, maxLength);
  }
  
  return safe || 'unnamed';
}

/**
 * Generate random color hex code
 * @returns {string} Hex color code
 */
function generateRandomColor() {
  const colors = [
    '#FF6B6B', '#4ECDC4', '#45B7D1', '#96CEB4', '#FECA57',
    '#FF9FF3', '#54A0FF', '#5F27CD', '#00D2D3', '#FF9F43',
    '#10AC84', '#EE5A24', '#0652DD', '#9C88FF', '#FFC312'
  ];
  
  return colors[Math.floor(Math.random() * colors.length)];
}

/**
 * Parse query string to object
 * @param {string} queryString - Query string to parse
 * @returns {Object} Parsed query object
 */
function parseQueryString(queryString) {
  if (!queryString || typeof queryString !== 'string') {
    return {};
  }
  
  const params = {};
  const pairs = queryString.replace(/^\?/, '').split('&');
  
  for (const pair of pairs) {
    const [key, value] = pair.split('=');
    if (key) {
      params[decodeURIComponent(key)] = value ? decodeURIComponent(value) : '';
    }
  }
  
  return params;
}

/**
 * Convert object to query string
 * @param {Object} obj - Object to convert
 * @returns {string} Query string
 */
function objectToQueryString(obj) {
  if (!obj || typeof obj !== 'object') {
    return '';
  }
  
  const pairs = [];
  for (const [key, value] of Object.entries(obj)) {
    if (value !== null && value !== undefined) {
      pairs.push(`${encodeURIComponent(key)}=${encodeURIComponent(value)}`);
    }
  }
  
  return pairs.length > 0 ? '?' + pairs.join('&') : '';
}

/**
 * Calculate percentage
 * @param {number} value - Current value
 * @param {number} total - Total value
 * @param {number} decimals - Decimal places
 * @returns {number} Percentage
 */
function calculatePercentage(value, total, decimals = 2) {
  if (total === 0) return 0;
  return parseFloat(((value / total) * 100).toFixed(decimals));
}

module.exports = {
  // String utilities
  generateRandomString,
  generateTicketId,
  generateComplaintId,
  sanitizeInput,
  truncateText,
  toTitleCase,
  generateHash,
  containsDevanagari,
  extractNumbers,
  extractEmojis,
  wordCount,
  
  // Phone number utilities
  formatPhoneNumber,
  isValidPhoneNumber,
  
  // Time utilities
  getCurrentTimestamp,
  formatTimestamp,
  getTimeDifference,
  
  // Validation utilities
  isValidEmail,
  isEmpty,
  
  // File utilities
  getFileExtension,
  createSafeFilename,
  formatFileSize,
  
  // Object utilities
  deepClone,
  parseQueryString,
  objectToQueryString,
  
  // Math utilities
  calculatePercentage,
  
  // Async utilities
  sleep,
  retryWithBackoff,
  
  // Crypto utilities
  generateUUID,
  
  // UI utilities
  generateRandomColor
};