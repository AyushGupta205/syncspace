import { randomUUID } from 'node:crypto';
import { Participant } from './Participant.js';

export const SESSION_GRACE_MS = 15 * 60 * 1000;

export class Room {
  constructor(id, videoId = '', { db = null, createdAt = Date.now(), currentTime = 0, isPlaying = false } = {}) {
    this.id = id;
    this.db = db;
    this.createdAt = createdAt;
    this.participants = new Map(); // participantId -> Participant
    this.socketIndex = new Map(); // socketId -> participantId
    this.state = {
      videoId,
      currentTime,
      isPlaying,
      playState: isPlaying ? 'PLAYING' : 'PAUSED',
      updatedAt: Date.now(),
    };
  }

  addParticipant(socketId, username) {
    const role = this.participants.size === 0 ? 'host' : 'participant';
    const participant = new Participant({
      id: randomUUID(),
      username,
      role,
      socketId,
      sessionToken: randomUUID(),
      connected: true,
      disconnectedAt: null,
    });

    this.participants.set(participant.id, participant);
    if (socketId) this.socketIndex.set(socketId, participant.id);
    this.db?.saveParticipant(this.id, participant);
    return participant;
  }

  loadParticipant(data) {
    const participant = new Participant(data);
    this.participants.set(participant.id, participant);
    if (participant.socketId && participant.connected) {
      this.socketIndex.set(participant.socketId, participant.id);
    }
    return participant;
  }

  resumeParticipant(socketId, sessionToken) {
    const participant = [...this.participants.values()].find(
      (member) => member.sessionToken === sessionToken
    );
    if (!participant) return null;
    if (participant.connected) return null;

    if (participant.isStale(SESSION_GRACE_MS)) {
      this.removeParticipant(participant.id);
      return null;
    }

    participant.setConnected(socketId);
    this.socketIndex.set(socketId, participant.id);
    this.db?.saveParticipant(this.id, participant);
    return participant;
  }

  disconnect(socketId) {
    const participant = this.getParticipant(socketId);
    if (!participant) return null;
    this.socketIndex.delete(socketId);
    participant.setDisconnected();
    this.db?.saveParticipant(this.id, participant);
    return participant;
  }

  removeParticipant(participantId) {
    const participant = this.participants.get(participantId);
    if (!participant) return null;
    this.participants.delete(participantId);
    for (const [socketId, id] of this.socketIndex) {
      if (id === participantId) this.socketIndex.delete(socketId);
    }
    this.db?.removeParticipant(participantId);
    return participant;
  }

  pruneDisconnected(now = Date.now()) {
    const expired = [...this.participants.values()]
      .filter((member) => member.isStale(SESSION_GRACE_MS, now))
      .map((member) => member.id);
    expired.forEach((id) => this.removeParticipant(id));
    return expired.length;
  }

  getParticipant(socketId) {
    return this.participants.get(this.socketIndex.get(socketId));
  }

  getParticipantById(participantId) {
    return this.participants.get(participantId);
  }

  hasControl(socketId) {
    const role = this.getParticipant(socketId)?.role;
    return role === 'host' || role === 'moderator';
  }

  isHost(socketId) {
    return this.getParticipant(socketId)?.role === 'host';
  }

  transferHost(targetParticipantId) {
    const currentHost = [...this.participants.values()].find((member) => member.role === 'host');
    const target = this.participants.get(targetParticipantId);
    if (!currentHost || !target || currentHost.id === target.id) return false;

    currentHost.role = 'moderator';
    target.role = 'host';
    this.db?.saveParticipant(this.id, currentHost);
    this.db?.saveParticipant(this.id, target);
    return true;
  }

  assignRole(targetParticipantId, newRole) {
    const member = this.participants.get(targetParticipantId);
    if (!member || !['moderator', 'participant'].includes(newRole)) return false;
    member.role = newRole;
    this.db?.saveParticipant(this.id, member);
    return true;
  }

  hasUsername(username) {
    const lower = String(username).toLowerCase();
    return [...this.participants.values()].some(
      (member) => member.username.toLowerCase() === lower
    );
  }

  listParticipants() {
    return [...this.participants.values()].map((member) => member.toJSON(false));
  }

  getState() {
    return {
      ...this.state,
      playState: this.state.isPlaying ? 'PLAYING' : 'PAUSED',
    };
  }

  setState(update) {
    const isPlaying =
      update.isPlaying !== undefined ? Boolean(update.isPlaying) : this.state.isPlaying;
    this.state = {
      ...this.state,
      ...update,
      isPlaying,
      playState: isPlaying ? 'PLAYING' : 'PAUSED',
      updatedAt: Date.now(),
    };
    this.db?.saveRoom(this);
    return this.getState();
  }
}
