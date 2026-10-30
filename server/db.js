import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

export class DatabaseService {
  constructor({ dbPath = process.env.DB_PATH || 'data/syncspace.db' } = {}) {
    this.dbPath = dbPath;
    this.db = null;
    this.init();
  }

  init() {
    try {
      if (this.dbPath !== ':memory:') {
        const dir = path.dirname(path.resolve(this.dbPath));
        if (!fs.existsSync(dir)) {
          fs.mkdirSync(dir, { recursive: true });
        }
      }
      this.db = new DatabaseSync(this.dbPath);
      this.db.exec(`
        PRAGMA journal_mode = WAL;
        PRAGMA busy_timeout = 5000;
        PRAGMA foreign_keys = ON;
        CREATE TABLE IF NOT EXISTS rooms (
          id TEXT PRIMARY KEY,
          video_id TEXT,
          current_time REAL DEFAULT 0,
          is_playing INTEGER DEFAULT 0,
          created_at INTEGER,
          updated_at INTEGER
        );
        CREATE TABLE IF NOT EXISTS participants (
          id TEXT PRIMARY KEY,
          room_id TEXT,
          username TEXT,
          role TEXT,
          session_token TEXT,
          connected INTEGER DEFAULT 0,
          disconnected_at INTEGER,
          FOREIGN KEY (room_id) REFERENCES rooms(id) ON DELETE CASCADE
        );
      `);
    } catch (err) {
      console.warn('[SyncSpace DB] Warning: SQLite persistence unavailable, falling back to memory mode.', err?.message);
      this.db = null;
    }
  }

  saveRoom(room) {
    if (!this.db) return;
    try {
      const state = room.getState ? room.getState() : room.state;
      const stmt = this.db.prepare(`
        INSERT INTO rooms (id, video_id, current_time, is_playing, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
          video_id = excluded.video_id,
          current_time = excluded.current_time,
          is_playing = excluded.is_playing,
          updated_at = excluded.updated_at
      `);
      stmt.run(
        room.id,
        state.videoId || '',
        state.currentTime || 0,
        state.isPlaying ? 1 : 0,
        room.createdAt || Date.now(),
        state.updatedAt || Date.now()
      );
    } catch (err) {
      console.error('[SyncSpace DB] Failed to save room:', err?.message);
    }
  }

  saveParticipant(roomId, participant) {
    if (!this.db) return;
    try {
      const stmt = this.db.prepare(`
        INSERT INTO participants (id, room_id, username, role, session_token, connected, disconnected_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
          username = excluded.username,
          role = excluded.role,
          connected = excluded.connected,
          disconnected_at = excluded.disconnected_at
      `);
      stmt.run(
        participant.id,
        roomId,
        participant.username,
        participant.role,
        participant.sessionToken,
        participant.connected ? 1 : 0,
        participant.disconnectedAt || null
      );
    } catch (err) {
      console.error('[SyncSpace DB] Failed to save participant:', err?.message);
    }
  }

  removeParticipant(participantId) {
    if (!this.db) return;
    try {
      this.db.prepare('DELETE FROM participants WHERE id = ?').run(participantId);
    } catch (err) {
      console.error('[SyncSpace DB] Failed to remove participant:', err?.message);
    }
  }

  deleteRoom(roomId) {
    if (!this.db) return;
    try {
      this.db.prepare('DELETE FROM participants WHERE room_id = ?').run(roomId);
      this.db.prepare('DELETE FROM rooms WHERE id = ?').run(roomId);
    } catch (err) {
      console.error('[SyncSpace DB] Failed to delete room:', err?.message);
    }
  }

  loadAllRooms() {
    if (!this.db) return [];
    try {
      const rooms = this.db.prepare('SELECT * FROM rooms').all();
      return rooms.map((r) => {
        const parts = this.db.prepare('SELECT * FROM participants WHERE room_id = ?').all(r.id);
        return {
          id: r.id,
          videoId: r.video_id,
          currentTime: r.current_time,
          isPlaying: Boolean(r.is_playing),
          createdAt: r.created_at,
          updatedAt: r.updated_at,
          participants: parts.map((p) => ({
            id: p.id,
            username: p.username,
            role: p.role,
            sessionToken: p.session_token,
            connected: false,
            disconnectedAt: p.disconnected_at || Date.now(),
          })),
        };
      });
    } catch (err) {
      console.error('[SyncSpace DB] Failed to load rooms:', err?.message);
      return [];
    }
  }

  close() {
    if (this.db) {
      try {
        this.db.close();
      } catch {}
      this.db = null;
    }
  }
}
