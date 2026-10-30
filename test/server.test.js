import test from 'node:test';
import assert from 'node:assert/strict';
import { io as client } from 'socket.io-client';
import { createPartyServer } from '../server/index.js';

const VIDEO_A = 'dQw4w9WgXcQ';
const VIDEO_B = '9bZkp7q19f0';
const delay = (ms = 40) => new Promise((resolve) => setTimeout(resolve, ms));
const once = (socket, event) => new Promise((resolve) => socket.once(event, resolve));
const emit = (socket, event, data) => new Promise((resolve) => socket.emit(event, data, resolve));

test('room creation, authorization, synchronization, isolation, removal, and reconnection', async (t) => {
  const { httpServer, io, rooms, pruneTimer, db } = createPartyServer({ serveClient: false, dbPath: ':memory:' });
  await new Promise((resolve) => httpServer.listen(0, resolve));
  const url = `http://127.0.0.1:${httpServer.address().port}`;
  const sockets = [];
  const connect = async () => { const socket = client(url, { transports: ['websocket'], forceNew: true }); sockets.push(socket); await once(socket, 'connect'); return socket; };
  t.after(async () => { clearInterval(pruneTimer); sockets.forEach((socket) => socket.close()); io.close(); await new Promise((resolve) => httpServer.close(resolve)); });

  const host = await connect();
  const blankCreate = await emit(host, 'create_room', { username: '   ', videoId: VIDEO_A });
  assert.match(blankCreate.error, /display name/);
  const invalidCreate = await emit(host, 'create_room', { username: 'Host', videoId: 'invalid' });
  assert.match(invalidCreate.error, /valid YouTube/);
  const created = await emit(host, 'create_room', { username: 'Host', videoId: VIDEO_A });
  assert.match(created.roomId, /^[A-Z0-9]{6}$/);
  assert.equal(created.self.role, 'host');
  const guest = await connect();
  const joined = await emit(guest, 'join_room', { roomId: created.roomId, username: 'Guest' });
  assert.equal(joined.self.role, 'participant');
  assert.match((await emit(guest, 'join_room', { roomId: created.roomId, username: 'Guest again' })).error, /already in this room/);
  assert.equal((await emit(await connect(), 'join_room', { roomId: created.roomId, username: 'guest' })).error, 'That display name is already in this room.');

  const rejected = once(guest, 'action_rejected');
  guest.emit('playback', { roomId: created.roomId, type: 'play', time: 8 });
  assert.match((await rejected).message, /Only a host/);
  const malformed = once(host, 'action_rejected');
  host.emit('playback', { roomId: created.roomId, type: 'seek', time: -1 });
  assert.match((await malformed).message, /Invalid playback position/);
  const syncedPlay = once(guest, 'sync_state'); host.emit('playback', { roomId: created.roomId, type: 'play', time: 12 });
  const played = await syncedPlay; assert.equal(played.videoId, VIDEO_A); assert.equal(played.currentTime, 12); assert.equal(played.isPlaying, true);
  
  const seek = once(guest, 'sync_state'); host.emit('playback', { roomId: created.roomId, type: 'seek', time: 42 }); assert.equal((await seek).currentTime, 42);
  const video = once(guest, 'sync_state'); host.emit('playback', { roomId: created.roomId, type: 'video', videoId: VIDEO_B }); assert.equal((await video).videoId, VIDEO_B);
  const lateJoiner = await connect(); const lateState = await emit(lateJoiner, 'join_room', { roomId: created.roomId, username: 'Late' }); assert.equal(lateState.state.videoId, VIDEO_B); assert.equal(lateState.state.currentTime, 0); await delay();

  const roleChange = once(guest, 'participants_updated'); host.emit('assign_role', { roomId: created.roomId, userId: joined.self.id, role: 'moderator' });
  assert.equal((await roleChange).find((member) => member.id === joined.self.id).role, 'moderator');
  const invalidRole = once(host, 'action_rejected'); host.emit('assign_role', { roomId: created.roomId, userId: joined.self.id, role: 'host' }); assert.match((await invalidRole).message, /Invalid role/);
  const modSync = once(host, 'sync_state'); guest.emit('playback', { roomId: created.roomId, type: 'pause', time: 42 }); assert.equal((await modSync).isPlaying, false);
  const chat = once(host, 'chat_message'); guest.emit('chat', { roomId: created.roomId, text: '<img src=x onerror=alert(1)>' }); assert.equal((await chat).text, '<img src=x onerror=alert(1)>');

  const otherHost = await connect(); const other = await emit(otherHost, 'create_room', { username: 'Other', videoId: VIDEO_A });
  let leaked = false; guest.once('sync_state', () => { leaked = true; }); otherHost.emit('playback', { roomId: other.roomId, type: 'play', time: 3 }); await delay(); assert.equal(leaked, false);

  const removal = once(guest, 'removed_from_room'); host.emit('remove_participant', { roomId: created.roomId, userId: joined.self.id }); await removal;
  const blocked = once(guest, 'action_rejected'); guest.emit('playback', { roomId: created.roomId, type: 'play', time: 2 }); assert.match((await blocked).message, /not a member/);

  host.disconnect(); await delay();
  const reconnect = await connect();
  const resumed = await emit(reconnect, 'resume_room', { roomId: created.roomId, sessionToken: created.self.sessionToken });
  assert.equal(resumed.self.role, 'host');
  otherHost.disconnect(); await delay();
  const staleRoom = rooms.get(other.roomId); staleRoom.getParticipantById(other.self.id).disconnectedAt = Date.now() - (16 * 60 * 1000);
  staleRoom.pruneDisconnected(); assert.equal(staleRoom.participants.size, 0);
});

test('host transfer, reactions, direct play/pause/seek/change_video events, and granular room broadcasts', async (t) => {
  const { httpServer, io, pruneTimer, db } = createPartyServer({ serveClient: false, dbPath: ':memory:' });
  await new Promise((resolve) => httpServer.listen(0, resolve));
  const url = `http://127.0.0.1:${httpServer.address().port}`;
  const sockets = [];
  const connect = async () => { const socket = client(url, { transports: ['websocket'], forceNew: true }); sockets.push(socket); await once(socket, 'connect'); return socket; };
  t.after(async () => { clearInterval(pruneTimer); sockets.forEach((socket) => socket.close()); io.close(); await new Promise((resolve) => httpServer.close(resolve)); });

  const host = await connect();
  const room = await emit(host, 'create_room', { username: 'HostUser', videoId: VIDEO_A });
  const guest = await connect();

  // Test user_joined broadcast
  const userJoinedPromise = once(host, 'user_joined');
  const joined = await emit(guest, 'join_room', { roomId: room.roomId, username: 'GuestUser' });
  const joinedEvent = await userJoinedPromise;
  assert.equal(joinedEvent.username, 'GuestUser');
  assert.equal(joinedEvent.role, 'participant');

  // Test direct play event
  const playPromise = once(guest, 'sync_state');
  host.emit('play', { roomId: room.roomId, time: 20 });
  const playState = await playPromise;
  assert.equal(playState.isPlaying, true);
  assert.equal(playState.currentTime, 20);

  // Test direct pause event
  const pausePromise = once(guest, 'sync_state');
  host.emit('pause', { roomId: room.roomId, time: 25 });
  const pauseState = await pausePromise;
  assert.equal(pauseState.isPlaying, false);
  assert.equal(pauseState.currentTime, 25);

  // Test direct seek event
  const seekPromise = once(guest, 'sync_state');
  host.emit('seek', { roomId: room.roomId, time: 60 });
  const seekState = await seekPromise;
  assert.equal(seekState.currentTime, 60);

  // Test direct change_video event
  const changeVidPromise = once(guest, 'sync_state');
  host.emit('change_video', { roomId: room.roomId, videoId: VIDEO_B });
  const vidState = await changeVidPromise;
  assert.equal(vidState.videoId, VIDEO_B);

  // Test reaction event
  const reactionPromise = once(host, 'reaction');
  guest.emit('reaction', { roomId: room.roomId, emoji: '🔥' });
  const reactionData = await reactionPromise;
  assert.equal(reactionData.emoji, '🔥');
  assert.equal(reactionData.username, 'GuestUser');

  // Test transfer_host
  const roleAssignedPromise = once(guest, 'role_assigned');
  host.emit('transfer_host', { roomId: room.roomId, userId: joined.self.id });
  const roleEvent = await roleAssignedPromise;
  assert.equal(roleEvent.role, 'host');
  assert.equal(roleEvent.userId, joined.self.id);

  // Now Guest is host, can control playback
  const newHostSync = once(host, 'sync_state');
  guest.emit('play', { roomId: room.roomId, time: 10 });
  const newSync = await newHostSync;
  assert.equal(newSync.isPlaying, true);
});

test('SQLite persistent room recovery across server restart and chat rate limiting', async (t) => {
  const fs = await import('node:fs');
  const path = await import('node:path');
  const tmpDb = path.join(process.cwd(), 'data', `test-persist-${Date.now()}.db`);
  t.after(() => {
    try { fs.unlinkSync(tmpDb); } catch {}
  });

  // Start instance 1
  const server1 = createPartyServer({ serveClient: false, dbPath: tmpDb });
  await new Promise((resolve) => server1.httpServer.listen(0, resolve));
  const url1 = `http://127.0.0.1:${server1.httpServer.address().port}`;
  const h1 = client(url1, { transports: ['websocket'], forceNew: true });
  await once(h1, 'connect');

  const created = await emit(h1, 'create_room', { username: 'PersistentHost', videoId: VIDEO_A });
  h1.emit('play', { roomId: created.roomId, time: 45 });
  await delay(100);

  // Close instance 1
  h1.close();
  await server1.close();

  // Start instance 2 pointing to the same SQLite DB
  const server2 = createPartyServer({ serveClient: false, dbPath: tmpDb });
  await new Promise((resolve) => server2.httpServer.listen(0, resolve));
  const url2 = `http://127.0.0.1:${server2.httpServer.address().port}`;
  const h2 = client(url2, { transports: ['websocket'], forceNew: true });
  await once(h2, 'connect');
  t.after(async () => {
    h2.close();
    await server2.close();
  });

  // Verify room was restored in server 2
  const restoredRoom = server2.roomManager.getRoom(created.roomId);
  assert(restoredRoom, 'Room must be restored in server 2');
  assert.equal(restoredRoom.state.videoId, VIDEO_A);
  assert.equal(restoredRoom.state.currentTime, 45);

  // Reconnect host using session token
  const resumed = await emit(h2, 'resume_room', {
    roomId: created.roomId,
    sessionToken: created.self.sessionToken,
  });
  assert.equal(resumed.self.username, 'PersistentHost');
  assert.equal(resumed.self.role, 'host');

  // Verify chat rate limit
  let rateLimited = false;
  h2.on('chat_rate_limited', () => { rateLimited = true; });
  for (let i = 0; i < 7; i++) {
    h2.emit('chat', { roomId: created.roomId, message: `msg ${i}` });
  }
  await delay(100);
  assert.equal(rateLimited, true, 'Chat rate limiter should trigger when flooding');
});
