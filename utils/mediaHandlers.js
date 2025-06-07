// utils/mediaHandlers.js
const axios = require('axios');
const fs = require('fs');
const path = require('path');
const logger = require('./logger');

/**
 * Download audio file from WhatsApp media URL
 */
async function downloadAudioFile(mediaUrl, mediaId) {
  try {
    const audioDir = path.join(process.cwd(), 'temp', 'audio');
    
    // Ensure directory exists
    if (!fs.existsSync(audioDir)) {
      fs.mkdirSync(audioDir, { recursive: true });
    }
    
    const fileName = `${mediaId}_${Date.now()}.ogg`;
    const localPath = path.join(audioDir, fileName);
    
    const response = await axios.get(mediaUrl, {
      responseType: 'arraybuffer',
      headers: { 
        'Authorization': `Bearer ${process.env.WHATSAPP_TOKEN}` 
      },
      timeout: 30000 // 30 second timeout
    });
    
    fs.writeFileSync(localPath, Buffer.from(response.data));
    
    logger.info(`Audio file downloaded successfully: ${fileName}`);
    return localPath;
  } catch (error) {
    logger.error(`Error downloading audio file: ${error.message}`, { mediaId });
    throw error;
  }
}

/**
 * Download image file from WhatsApp media URL
 */
async function downloadImageFile(mediaUrl, mediaId) {
  try {
    const imageDir = path.join(process.cwd(), 'temp', 'images');
    
    // Ensure directory exists
    if (!fs.existsSync(imageDir)) {
      fs.mkdirSync(imageDir, { recursive: true });
    }
    
    const fileName = `${mediaId}_${Date.now()}.jpg`;
    const localPath = path.join(imageDir, fileName);
    
    const response = await axios.get(mediaUrl, {
      responseType: 'arraybuffer',
      headers: { 
        'Authorization': `Bearer ${process.env.WHATSAPP_TOKEN}` 
      },
      timeout: 30000 // 30 second timeout
    });
    
    fs.writeFileSync(localPath, Buffer.from(response.data));
    
    logger.info(`Image file downloaded successfully: ${fileName}`);
    return localPath;
  } catch (error) {
    logger.error(`Error downloading image file: ${error.message}`, { mediaId });
    throw error;
  }
}

/**
 * Download video file from WhatsApp media URL
 */
async function downloadVideoFile(mediaUrl, mediaId) {
  try {
    const videoDir = path.join(process.cwd(), 'temp', 'videos');
    
    // Ensure directory exists
    if (!fs.existsSync(videoDir)) {
      fs.mkdirSync(videoDir, { recursive: true });
    }
    
    const fileName = `${mediaId}_${Date.now()}.mp4`;
    const localPath = path.join(videoDir, fileName);
    
    const response = await axios.get(mediaUrl, {
      responseType: 'arraybuffer',
      headers: { 
        'Authorization': `Bearer ${process.env.WHATSAPP_TOKEN}` 
      },
      timeout: 60000 // 60 second timeout for videos
    });
    
    fs.writeFileSync(localPath, Buffer.from(response.data));
    
    logger.info(`Video file downloaded successfully: ${fileName}`);
    return localPath;
  } catch (error) {
    logger.error(`Error downloading video file: ${error.message}`, { mediaId });
    throw error;
  }
}

/**
 * Download document file from WhatsApp media URL
 */
async function downloadDocumentFile(mediaUrl, mediaId, mimeType = '') {
  try {
    const documentDir = path.join(process.cwd(), 'temp', 'documents');
    
    // Ensure directory exists
    if (!fs.existsSync(documentDir)) {
      fs.mkdirSync(documentDir, { recursive: true });
    }
    
    // Determine file extension from mime type
    const extension = getFileExtensionFromMimeType(mimeType) || 'bin';
    const fileName = `${mediaId}_${Date.now()}.${extension}`;
    const localPath = path.join(documentDir, fileName);
    
    const response = await axios.get(mediaUrl, {
      responseType: 'arraybuffer',
      headers: { 
        'Authorization': `Bearer ${process.env.WHATSAPP_TOKEN}` 
      },
      timeout: 60000 // 60 second timeout
    });
    
    fs.writeFileSync(localPath, Buffer.from(response.data));
    
    logger.info(`Document file downloaded successfully: ${fileName}`);
    return localPath;
  } catch (error) {
    logger.error(`Error downloading document file: ${error.message}`, { mediaId });
    throw error;
  }
}

/**
 * Get file extension from MIME type
 */
function getFileExtensionFromMimeType(mimeType) {
  const mimeToExt = {
    'application/pdf': 'pdf',
    'application/msword': 'doc',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'docx',
    'application/vnd.ms-excel': 'xls',
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': 'xlsx',
    'application/vnd.ms-powerpoint': 'ppt',
    'application/vnd.openxmlformats-officedocument.presentationml.presentation': 'pptx',
    'text/plain': 'txt',
    'text/csv': 'csv',
    'image/jpeg': 'jpg',
    'image/png': 'png',
    'image/gif': 'gif',
    'image/webp': 'webp',
    'audio/mpeg': 'mp3',
    'audio/ogg': 'ogg',
    'audio/wav': 'wav',
    'video/mp4': 'mp4',
    'video/avi': 'avi',
    'video/quicktime': 'mov'
  };
  
  return mimeToExt[mimeType] || null;
}

/**
 * Clean up temporary files older than specified time
 */
function cleanupTempFiles(maxAge = 24 * 60 * 60 * 1000) { // 24 hours default
  const tempDir = path.join(process.cwd(), 'temp');
  
  if (!fs.existsSync(tempDir)) {
    return;
  }
  
  const now = Date.now();
  
  function cleanDirectory(dirPath) {
    try {
      const files = fs.readdirSync(dirPath);
      
      files.forEach(file => {
        const filePath = path.join(dirPath, file);
        const stats = fs.statSync(filePath);
        
        if (stats.isDirectory()) {
          cleanDirectory(filePath);
          
          // Remove empty directories
          try {
            fs.rmdirSync(filePath);
          } catch (error) {
            // Directory not empty, ignore
          }
        } else {
          const fileAge = now - stats.mtime.getTime();
          
          if (fileAge > maxAge) {
            try {
              fs.unlinkSync(filePath);
              logger.info(`Cleaned up old temp file: ${file}`);
            } catch (error) {
              logger.error(`Error cleaning up temp file: ${error.message}`, { file });
            }
          }
        }
      });
    } catch (error) {
      logger.error(`Error cleaning directory: ${error.message}`, { dirPath });
    }
  }
  
  cleanDirectory(tempDir);
}

/**
 * Get file size in human readable format
 */
function getFileSizeString(bytes) {
  if (bytes === 0) return '0 Bytes';
  
  const k = 1024;
  const sizes = ['Bytes', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  
  return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
}

/**
 * Validate file type for security
 */
function isAllowedFileType(mimeType) {
  const allowedTypes = [
    // Images
    'image/jpeg', 'image/png', 'image/gif', 'image/webp',
    // Audio
    'audio/mpeg', 'audio/ogg', 'audio/wav', 'audio/mp4',
    // Video
    'video/mp4', 'video/avi', 'video/quicktime',
    // Documents
    'application/pdf', 'application/msword',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    'application/vnd.ms-excel',
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    'text/plain', 'text/csv'
  ];
  
  return allowedTypes.includes(mimeType);
}

/**
 * Convert audio to different format if needed
 */
async function convertAudioFormat(inputPath, outputFormat = 'wav') {
  // This would require ffmpeg or similar tool
  // For now, return the original path
  logger.info(`Audio conversion requested: ${inputPath} -> ${outputFormat}`);
  return inputPath;
}

module.exports = {
  downloadAudioFile,
  downloadImageFile,
  downloadVideoFile,
  downloadDocumentFile,
  getFileExtensionFromMimeType,
  cleanupTempFiles,
  getFileSizeString,
  isAllowedFileType,
  convertAudioFormat
};