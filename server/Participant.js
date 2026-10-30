export class Participant {
  constructor({
    id,
    username,
    role = 'participant',
    socketId = null,
    sessionToken,
    connected = true,
    disconnectedAt = null,
  }) {
    this.id = id;
    this.username = username;
    this.role = role;
    this.socketId = socketId;
    this.sessionToken = sessionToken;
    this.connected = connected;
    this.disconnectedAt = disconnectedAt;
  }

  setConnected(socketId) {
    this.connected = true;
    this.socketId = socketId;
    this.disconnectedAt = null;
  }

  setDisconnected() {
    this.connected = false;
    this.socketId = null;
    this.disconnectedAt = Date.now();
  }

  isStale(graceMs = 15 * 60 * 1000, now = Date.now()) {
    return !this.connected && this.disconnectedAt && now - this.disconnectedAt > graceMs;
  }

  toJSON(includePrivate = false) {
    const data = {
      id: this.id,
      username: this.username,
      role: this.role,
      connected: this.connected,
    };
    if (includePrivate) {
      data.sessionToken = this.sessionToken;
    }
    return data;
  }
}
