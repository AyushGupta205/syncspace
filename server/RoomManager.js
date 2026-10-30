import { Room } from './Room.js';

export class RoomManager {
  constructor({ db = null } = {}) {
    this.rooms = new Map(); // roomId -> Room
    this.db = db;
    this.createRateMap = new Map(); // ip or socketId -> timestamps
    this.restoreFromDb();
  }

  generateCode() {
    let id;
    do {
      id = Math.random().toString(36).slice(2, 8).toUpperCase();
    } while (this.rooms.has(id));
    return id;
  }

  createRoom(videoId = '') {
    const id = this.generateCode();
    const room = new Room(id, videoId, { db: this.db });
    this.rooms.set(id, room);
    this.db?.saveRoom(room);
    return room;
  }

  getRoom(roomId) {
    if (!roomId || typeof roomId !== 'string') return null;
    return this.rooms.get(roomId.trim().toUpperCase()) || null;
  }

  deleteRoom(roomId) {
    this.rooms.delete(roomId);
    this.db?.deleteRoom(roomId);
  }

  prune(io) {
    for (const [roomId, room] of this.rooms) {
      const changed = room.pruneDisconnected();
      if (!room.participants.size) {
        this.deleteRoom(roomId);
      } else if (changed && io) {
        io.to(roomId).emit('participants_updated', room.listParticipants());
      }
    }
  }

  restoreFromDb() {
    if (!this.db) return;
    try {
      const savedRooms = this.db.loadAllRooms();
      for (const r of savedRooms) {
        const room = new Room(r.id, r.videoId, {
          db: this.db,
          createdAt: r.createdAt,
          currentTime: r.currentTime,
          isPlaying: r.isPlaying,
        });
        for (const p of r.participants) {
          room.loadParticipant(p);
        }
        // If room has participants or is fresh, retain it
        if (room.participants.size > 0) {
          this.rooms.set(room.id, room);
        } else {
          this.db.deleteRoom(r.id);
        }
      }
      if (savedRooms.length > 0) {
        console.log(`[SyncSpace DB] Restored ${this.rooms.size} active room(s) from persistent storage.`);
      }
    } catch (err) {
      console.error('[SyncSpace DB] Error restoring rooms:', err);
    }
  }

  checkCreateRateLimit(identifier, limit = 5, windowMs = 60000, now = Date.now()) {
    let timestamps = this.createRateMap.get(identifier) || [];
    timestamps = timestamps.filter((t) => now - t < windowMs);
    if (timestamps.length >= limit) {
      this.createRateMap.set(identifier, timestamps);
      return false;
    }
    timestamps.push(now);
    this.createRateMap.set(identifier, timestamps);
    return true;
  }
}
