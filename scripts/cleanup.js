// scripts/cleanup.js
const fs = require('fs');
const path = require('path');
const { cleanupTempFiles } = require('../utils/mediaHandlers');
const logger = require('../utils/logger');

/**
 * Cleanup old temporary files and logs
 */
function cleanup() {
  logger.info('Starting cleanup process...');
  
  try {
    // Clean up temporary files older than 24 hours
    cleanupTempFiles(24 * 60 * 60 * 1000);
    
    // Clean up old log files (keep last 30 days)
    const logDir = path.join(process.cwd(), 'logs');
    if (fs.existsSync(logDir)) {
      const files = fs.readdirSync(logDir);
      const thirtyDaysAgo = Date.now() - (30 * 24 * 60 * 60 * 1000);
      
      files.forEach(file => {
        const filePath = path.join(logDir, file);
        const stats = fs.statSync(filePath);
        
        if (stats.mtime.getTime() < thirtyDaysAgo) {
          fs.unlinkSync(filePath);
          logger.info(`Removed old log file: ${file}`);
        }
      });
    }
    
    logger.info('Cleanup process completed successfully');
  } catch (error) {
    logger.error(`Cleanup process failed: ${error.message}`);
  }
}

// Run cleanup if called directly
if (require.main === module) {
  cleanup();
}

module.exports = { cleanup };