'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const config = require('../../config');
const logger = require('../../utils/logger');

class MessageStore {
  /**
   * Store a raw email message to disk
   * @returns {string} Storage path
   */
  static async store(mailboxId, messageId, rawBuffer) {
    const dir = path.join(config.storage.mailPath, mailboxId.substring(0, 2), mailboxId);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    const filePath = path.join(dir, `${messageId}.eml`);
    fs.writeFileSync(filePath, rawBuffer);
    return filePath;
  }

  /**
   * Read a raw message from disk
   */
  static async read(rawPath) {
    try {
      return fs.readFileSync(rawPath);
    } catch (err) {
      logger.error('MessageStore read error', { path: rawPath, error: err.message });
      return null;
    }
  }

  /**
   * Delete a message from disk
   */
  static async delete(rawPath) {
    try {
      if (rawPath && fs.existsSync(rawPath)) {
        fs.unlinkSync(rawPath);
      }
    } catch (err) {
      logger.error('MessageStore delete error', { path: rawPath, error: err.message });
    }
  }

  /**
   * Calculate size of stored messages for a mailbox
   */
  static async calculateUsage(mailboxId) {
    const dir = path.join(config.storage.mailPath, mailboxId.substring(0, 2), mailboxId);
    if (!fs.existsSync(dir)) return 0;
    let total = 0;
    for (const file of fs.readdirSync(dir)) {
      try {
        total += fs.statSync(path.join(dir, file)).size;
      } catch {}
    }
    return total;
  }

  /**
   * Ensure base storage directories exist
   */
  static init() {
    [config.storage.mailPath, config.storage.attachmentPath].forEach(dir => {
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
        logger.debug('Created storage directory', { dir });
      }
    });
  }
}

module.exports = MessageStore;
