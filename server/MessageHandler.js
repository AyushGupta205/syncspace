export class MessageHandler {
  constructor({ maxLen = 500, maxPerWindow = 5, windowMs = 2000 } = {}) {
    this.maxLen = maxLen;
    this.maxPerWindow = maxPerWindow;
    this.windowMs = windowMs;
    this.rateMap = new Map(); // socketId -> array of timestamps
  }

  checkRateLimit(socketId, now = Date.now()) {
    let timestamps = this.rateMap.get(socketId) || [];
    timestamps = timestamps.filter((t) => now - t < this.windowMs);
    if (timestamps.length >= this.maxPerWindow) {
      this.rateMap.set(socketId, timestamps);
      return false;
    }
    timestamps.push(now);
    this.rateMap.set(socketId, timestamps);
    return true;
  }

  cleanupSocket(socketId) {
    this.rateMap.delete(socketId);
  }

  validateAndSanitize(rawText) {
    if (typeof rawText !== 'string') return '';
    const trimmed = rawText.trim();
    if (!trimmed) return '';
    return trimmed.slice(0, this.maxLen);
  }

  createMessage({ socketId, username, text }) {
    const sanitized = this.validateAndSanitize(text);
    if (!sanitized) return null;
    const now = Date.now();
    return {
      id: `${socketId}-${now}-${Math.random().toString(36).slice(2, 6)}`,
      username,
      text: sanitized,
      message: sanitized,
      time: now,
      timestamp: now,
    };
  }

  createReaction({ socketId, username, emoji }) {
    if (!emoji || typeof emoji !== 'string') return null;
    const cleanEmoji = emoji.trim().slice(0, 8);
    if (!cleanEmoji) return null;
    const now = Date.now();
    return {
      id: `rx-${socketId}-${now}-${Math.random().toString(36).slice(2, 6)}`,
      username,
      emoji: cleanEmoji,
      time: now,
    };
  }
}
