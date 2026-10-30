const VIDEO_ID = /^[\w-]{11}$/;
const ROOM_ID = /^[A-Z0-9]{6}$/;

const safeName = (value) =>
  String(value || '')
    .trim()
    .replace(/\s+/g, ' ')
    .slice(0, 24);

export class SocketEventHandler {
  constructor({ io, roomManager, messageHandler }) {
    this.io = io;
    this.roomManager = roomManager;
    this.messageHandler = messageHandler;
    this.joinRateMap = new Map(); // socket.id -> timestamps
  }

  reject(socket, message) {
    socket.emit('action_rejected', { message, error: message });
  }

  payload(room, member) {
    return {
      roomId: room.id,
      self: member.toJSON(true),
      participants: room.listParticipants(),
      state: room.getState ? room.getState() : room.state,
    };
  }

  broadcastPeople(room) {
    this.io.to(room.id).emit('participants_updated', room.listParticipants());
  }

  enter(socket, room, username, reply) {
    if (!username) {
      return reply?.({ error: 'Choose a display name to continue.' });
    }
    if (room.getParticipant(socket.id)) {
      return reply?.({ error: 'You are already in this room.' });
    }
    if (room.hasUsername(username)) {
      return reply?.({ error: 'That display name is already in this room.' });
    }

    const member = room.addParticipant(socket.id, username);
    socket.join(room.id);
    const result = this.payload(room, member);
    reply?.(result);
    socket.emit('room_joined', result);
    socket.to(room.id).emit('participants_updated', room.listParticipants());
    socket.to(room.id).emit('user_joined', {
      username: member.username,
      userId: member.id,
      role: member.role,
      participants: room.listParticipants(),
    });
  }

  handlePlayback(socket, data = {}) {
    const room = this.roomManager.getRoom(data.roomId);
    if (!room?.getParticipant(socket.id)) {
      return this.reject(socket, 'You are not a member of this room.');
    }
    if (!room.hasControl(socket.id)) {
      return this.reject(socket, 'Only a host or moderator can control playback.');
    }
    if (!['play', 'pause', 'seek', 'video'].includes(data.type)) {
      return this.reject(socket, 'Unknown playback action.');
    }
    if (data.type === 'video' && !VIDEO_ID.test(data.videoId || '')) {
      return this.reject(socket, 'Invalid YouTube video ID.');
    }

    const targetTime = Number.isFinite(data.time)
      ? data.time
      : Number.isFinite(data.currentTime)
      ? data.currentTime
      : 0;

    if (data.type !== 'video' && (targetTime < 0 || targetTime > 86400)) {
      return this.reject(socket, 'Invalid playback position.');
    }

    const update =
      data.type === 'video'
        ? { videoId: data.videoId, currentTime: 0, isPlaying: false }
        : data.type === 'play'
        ? { isPlaying: true, currentTime: targetTime }
        : data.type === 'pause'
        ? { isPlaying: false, currentTime: targetTime }
        : { currentTime: targetTime };

    this.io.to(room.id).emit('sync_state', room.setState(update));
  }

  register(socket) {
    // 1. Room Creation
    socket.on('create_room', (data = {}, reply) => {
      const clientIp = socket.handshake.address || socket.id;
      if (!this.roomManager.checkCreateRateLimit(clientIp, 10, 60000)) {
        return reply?.({ error: 'Too many rooms created recently. Please wait a minute.' });
      }

      const username = safeName(data.username);
      if (!username) {
        return reply?.({ error: 'Choose a display name to continue.' });
      }
      const videoId = String(data.videoId || '');
      if (videoId && !VIDEO_ID.test(videoId)) {
        return reply?.({ error: 'Paste a valid YouTube link or video ID.' });
      }

      const room = this.roomManager.createRoom(videoId);
      this.enter(socket, room, username, reply);
    });

    // 2. Room Joining
    socket.on('join_room', (data = {}, reply) => {
      const roomId = String(data.roomId || '').trim().toUpperCase();
      const room = this.roomManager.getRoom(roomId);
      if (!ROOM_ID.test(roomId) || !room) {
        return reply?.({ error: 'Room not found. Check the six-character room code.' });
      }
      this.enter(socket, room, safeName(data.username), reply);
    });

    // 3. Resume Session
    socket.on('resume_room', (data = {}, reply) => {
      const room = this.roomManager.getRoom(data.roomId);
      const member = room?.resumeParticipant(socket.id, String(data.sessionToken || ''));
      if (!member) {
        return reply?.({ error: 'Your previous room session has expired.' });
      }
      socket.join(room.id);
      const result = this.payload(room, member);
      reply?.(result);
      socket.emit('room_joined', result);
      this.broadcastPeople(room);
    });

    // 4. Leave Room
    socket.on('leave_room', ({ roomId } = {}) => {
      const room = this.roomManager.getRoom(roomId);
      const member = room?.getParticipant(socket.id);
      if (!member) return;
      room.removeParticipant(member.id);
      socket.leave(room.id);
      this.io.to(room.id).emit('user_left', {
        username: member.username,
        userId: member.id,
        participants: room.listParticipants(),
      });
      if (!room.participants.size) {
        this.roomManager.deleteRoom(room.id);
      } else {
        this.broadcastPeople(room);
      }
    });

    // 5. Playback Handlers
    socket.on('playback', (data = {}) => this.handlePlayback(socket, data));
    socket.on('play', (data = {}) =>
      this.handlePlayback(socket, {
        roomId: data.roomId,
        type: 'play',
        time: data.time ?? data.currentTime,
      })
    );
    socket.on('pause', (data = {}) =>
      this.handlePlayback(socket, {
        roomId: data.roomId,
        type: 'pause',
        time: data.time ?? data.currentTime,
      })
    );
    socket.on('seek', (data = {}) =>
      this.handlePlayback(socket, {
        roomId: data.roomId,
        type: 'seek',
        time: data.time ?? data.currentTime,
      })
    );
    socket.on('change_video', (data = {}) =>
      this.handlePlayback(socket, {
        roomId: data.roomId,
        type: 'video',
        videoId: data.videoId,
      })
    );

    // 6. Role Assignment (Host only)
    socket.on('assign_role', (data = {}) => {
      const room = this.roomManager.getRoom(data.roomId);
      if (!room?.isHost(socket.id)) {
        return this.reject(socket, 'Only the host can change roles.');
      }
      const targetId = data.userId || data.targetId;
      const member = room.getParticipantById(targetId);
      if (!member || !['moderator', 'participant'].includes(data.role)) {
        return this.reject(socket, 'Invalid role change.');
      }
      if (room.assignRole(member.id, data.role)) {
        this.broadcastPeople(room);
        this.io.to(room.id).emit('role_assigned', {
          userId: member.id,
          username: member.username,
          role: member.role,
          participants: room.listParticipants(),
        });
      }
    });

    // 7. Host Transfer (Host only)
    socket.on('transfer_host', (data = {}) => {
      const room = this.roomManager.getRoom(data.roomId);
      const actor = room?.getParticipant(socket.id);
      if (!room || actor?.role !== 'host') {
        return this.reject(socket, 'Only the host can transfer host ownership.');
      }
      const member = room.getParticipantById(data.userId);
      if (!member || member.id === actor.id) {
        return this.reject(socket, 'Invalid host transfer target.');
      }
      if (room.transferHost(member.id)) {
        this.broadcastPeople(room);
        this.io.to(room.id).emit('role_assigned', {
          userId: member.id,
          username: member.username,
          role: 'host',
          participants: room.listParticipants(),
        });
      }
    });

    // 8. Participant Removal (Host only)
    socket.on('remove_participant', (data = {}) => {
      const room = this.roomManager.getRoom(data.roomId);
      const actor = room?.getParticipant(socket.id);
      if (!room || !actor?.role || actor.role !== 'host') {
        return this.reject(socket, 'Only the host can remove other participants.');
      }
      const member = room.getParticipantById(data.userId);
      if (!member || member.id === actor.id) {
        return this.reject(socket, 'Only the host can remove other participants.');
      }

      room.removeParticipant(member.id);
      for (const connectedSocket of this.io.sockets.sockets.values()) {
        if (
          connectedSocket.rooms.has(room.id) &&
          !room.getParticipant(connectedSocket.id)
        ) {
          connectedSocket.emit('removed_from_room');
          connectedSocket.leave(room.id);
        }
      }
      this.broadcastPeople(room);
      this.io.to(room.id).emit('participant_removed', {
        userId: member.id,
        participants: room.listParticipants(),
      });
    });

    // 9. Emoji Reactions
    socket.on('reaction', (data = {}) => {
      const room = this.roomManager.getRoom(data.roomId);
      const member = room?.getParticipant(socket.id);
      if (!room || !member) return;

      const reaction = this.messageHandler.createReaction({
        socketId: socket.id,
        username: member.username,
        emoji: data.emoji,
      });

      if (reaction) {
        this.io.to(room.id).emit('reaction', reaction);
      }
    });

    // 10. Room Chat
    socket.on('chat', (data = {}) => {
      const room = this.roomManager.getRoom(data.roomId);
      const member = room?.getParticipant(socket.id);
      if (!room || !member) return;

      if (!this.messageHandler.checkRateLimit(socket.id)) {
        return socket.emit('chat_rate_limited', {
          error: 'You are sending messages too quickly. Please wait a moment.',
        });
      }

      const msg = this.messageHandler.createMessage({
        socketId: socket.id,
        username: member.username,
        text: data.text || data.message || '',
      });

      if (msg) {
        this.io.to(room.id).emit('chat_message', msg);
      }
    });

    // 11. Disconnect
    socket.on('disconnect', () => {
      this.messageHandler.cleanupSocket(socket.id);
      for (const room of this.roomManager.rooms.values()) {
        if (room.disconnect(socket.id)) {
          this.broadcastPeople(room);
        }
      }
    });
  }
}
