import test from 'node:test';
import assert from 'node:assert/strict';
import { io as client } from 'socket.io-client';
import { createPartyServer } from '../server/index.js';

const VIDEO_A = 'dQw4w9WgXcQ';
const VIDEO_B = '9bZkp7q19f0';
const VIDEO_C = 'M7lc1UVf-VE';
const delay = (ms = 40) => new Promise((resolve) => setTimeout(resolve, ms));
const once = (socket, event, label = event) => new Promise((resolve, reject) => {
  const timer = setTimeout(() => {
    socket.off(event, handler);
    reject(new Error(`Timed out waiting for ${label}.`));
  }, 5000);
  const handler = (...args) => {
    clearTimeout(timer);
    resolve(...args);
  };
  socket.once(event, handler);
});
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
  const played = await syncedPlay; assert.equal(played.videoId, VIDEO_A); assert.ok(Math.abs(played.currentTime - 12) < 0.1); assert.equal(played.isPlaying, true); assert.equal(played.revision, 1);
  const activeRoom = rooms.get(created.roomId);
  activeRoom.state.updatedAt = Date.now() - 3500;
  assert.ok(activeRoom.getState().currentTime >= 15.4, 'playing room time should advance from its server anchor');
  const malformedTime = once(host, 'action_rejected');
  host.emit('playback', { roomId: created.roomId, type: 'seek', time: 'not-a-number' });
  assert.match((await malformedTime).message, /Invalid playback position/);
  
  const seek = once(guest, 'sync_state'); host.emit('playback', { roomId: created.roomId, type: 'seek', time: 42 }); const seekState = await seek; assert.ok(Math.abs(seekState.currentTime - 42) < 0.1); assert.equal(seekState.revision, 2);
  const video = once(guest, 'sync_state'); host.emit('playback', { roomId: created.roomId, type: 'video', videoId: VIDEO_B }); const videoState = await video; assert.equal(videoState.videoId, VIDEO_B); assert.equal(videoState.isPlaying, true); assert.equal(videoState.revision, 3);
  const lateJoiner = await connect(); const lateState = await emit(lateJoiner, 'join_room', { roomId: created.roomId, username: 'Late' }); assert.equal(lateState.state.videoId, VIDEO_B); assert.ok(lateState.state.currentTime < 1); assert.equal(lateState.state.isPlaying, true); await delay();

  const roleChange = once(guest, 'participants_updated'); host.emit('assign_role', { roomId: created.roomId, userId: joined.self.id, role: 'moderator' });
  assert.equal((await roleChange).find((member) => member.id === joined.self.id).role, 'moderator');
  const moderatorRoleRejected = once(guest, 'action_rejected');
  guest.emit('assign_role', { roomId: created.roomId, userId: lateState.self.id, role: 'participant' });
  assert.match((await moderatorRoleRejected).message, /Only the host/);
  const selfDemotion = once(host, 'action_rejected');
  host.emit('assign_role', { roomId: created.roomId, userId: created.self.id, role: 'participant' });
  assert.match((await selfDemotion).message, /Invalid role change/);
  const invalidRole = once(host, 'action_rejected'); host.emit('assign_role', { roomId: created.roomId, userId: joined.self.id, role: 'host' }); assert.match((await invalidRole).message, /Invalid role/);
  const modSync = once(host, 'sync_state'); guest.emit('playback', { roomId: created.roomId, type: 'pause', time: 42 }); assert.equal((await modSync).isPlaying, false);
  const chat = once(host, 'chat_message'); guest.emit('chat', { roomId: created.roomId, text: '<img src=x onerror=alert(1)>' }); assert.equal((await chat).text, '<img src=x onerror=alert(1)>');

  const otherHost = await connect(); const other = await emit(otherHost, 'create_room', { username: 'Other', videoId: VIDEO_A });
  let leaked = false; guest.once('sync_state', () => { leaked = true; }); otherHost.emit('playback', { roomId: other.roomId, type: 'play', time: 3 }); await delay(); assert.equal(leaked, false);

  const removal = once(guest, 'removed_from_room'); host.emit('remove_participant', { roomId: created.roomId, userId: joined.self.id }); await removal;
  const blocked = once(guest, 'action_rejected'); guest.emit('playback', { roomId: created.roomId, type: 'play', time: 2 }); assert.match((await blocked).message, /not a member/);

  const hostChanged = once(lateJoiner, 'host_changed');
  host.disconnect(); await delay();
  assert.equal((await hostChanged).userId, lateState.self.id);
  assert.equal(rooms.get(created.roomId).getParticipantById(lateState.self.id).role, 'host');
  const reconnect = await connect();
  const resumed = await emit(reconnect, 'resume_room', { roomId: created.roomId, sessionToken: created.self.sessionToken });
  assert.equal(resumed.self.role, 'participant');
  assert.equal(rooms.get(created.roomId).getParticipantById(lateState.self.id).role, 'host');
  otherHost.disconnect(); await delay();
  const staleRoom = rooms.get(other.roomId); staleRoom.getParticipantById(other.self.id).disconnectedAt = Date.now() - (16 * 60 * 1000);
  staleRoom.pruneDisconnected(); assert.equal(staleRoom.participants.size, 0);
});

test('session recovery replaces active sockets and preserves roles and authorization', async (t) => {
  const server = createPartyServer({ serveClient: false, dbPath: ':memory:' });
  await new Promise((resolve) => server.httpServer.listen(0, resolve));
  const url = `http://127.0.0.1:${server.httpServer.address().port}`;
  const sockets = [];
  const connect = async () => {
    const socket = client(url, { transports: ['websocket'], forceNew: true });
    sockets.push(socket);
    await once(socket, 'connect');
    return socket;
  };
  t.after(async () => {
    sockets.forEach((socket) => socket.close());
    await server.close();
  });

  const host = await connect();
  const created = await emit(host, 'create_room', { username: 'RecoveryHost' });
  const moderator = await connect();
  const moderatorJoined = await emit(moderator, 'join_room', {
    roomId: created.roomId,
    username: 'RecoveryModerator',
  });
  const participant = await connect();
  const participantJoined = await emit(participant, 'join_room', {
    roomId: created.roomId,
    username: 'RecoveryParticipant',
  });
  const roleUpdate = once(moderator, 'participants_updated');
  host.emit('assign_role', {
    roomId: created.roomId,
    userId: moderatorJoined.self.id,
    role: 'moderator',
  });
  assert.equal((await roleUpdate).find((member) => member.id === moderatorJoined.self.id).role, 'moderator');

  const invalidSession = await emit(await connect(), 'resume_room', {
    roomId: created.roomId,
    sessionToken: 'invalid-session-token',
  });
  assert.equal(invalidSession.code, 'SESSION_INVALID');

  const room = server.roomManager.getRoom(created.roomId);
  const moderatorOldSocketId = moderator.id;
  const moderatorDisconnect = once(moderator, 'disconnect');
  const moderatorReplacement = await connect();
  const resumedModerator = await emit(moderatorReplacement, 'resume_room', {
    roomId: created.roomId,
    sessionToken: moderatorJoined.self.sessionToken,
  });
  await moderatorDisconnect;
  assert.equal(resumedModerator.self.id, moderatorJoined.self.id);
  assert.equal(resumedModerator.self.username, 'RecoveryModerator');
  assert.equal(resumedModerator.self.role, 'moderator');
  assert.equal(room.participants.size, 3);
  assert.equal(room.getParticipant(moderatorOldSocketId), undefined);
  assert.equal(room.getParticipantById(moderatorJoined.self.id).socketId, moderatorReplacement.id);
  assert.equal(room.getParticipantById(moderatorJoined.self.id).connected, true);
  assert.equal(room.disconnect(moderatorOldSocketId), null, 'a stale disconnect must not affect the replacement socket');

  const syncedState = once(host, 'sync_state');
  const moderatorSocket = sockets.at(-1);
  moderatorSocket.emit('playback', { roomId: created.roomId, type: 'play', time: 12 });
  assert.equal((await syncedState).isPlaying, true, 'the recovered moderator retains playback control');
  const deniedRoleChange = once(moderatorSocket, 'action_rejected');
  moderatorSocket.emit('assign_role', {
    roomId: created.roomId,
    userId: participantJoined.self.id,
    role: 'moderator',
  });
  assert.match((await deniedRoleChange).message, /Only the host/);

  const hostOldSocketId = host.id;
  const hostDisconnect = once(host, 'disconnect');
  const hostReplacement = await connect();
  const resumedHost = await emit(hostReplacement, 'resume_room', {
    roomId: created.roomId,
    sessionToken: created.self.sessionToken,
  });
  await hostDisconnect;
  assert.equal(resumedHost.self.id, created.self.id);
  assert.equal(resumedHost.self.role, 'host');
  assert.equal(room.getParticipant(hostOldSocketId), undefined);
  assert.equal(room.isHost(hostReplacement.id), true);

  const participantOldSocketId = participant.id;
  const participantDisconnect = once(participant, 'disconnect');
  const participantReplacement = await connect();
  const resumedParticipant = await emit(participantReplacement, 'resume_room', {
    roomId: created.roomId,
    sessionToken: participantJoined.self.sessionToken,
  });
  await participantDisconnect;
  assert.equal(resumedParticipant.self.id, participantJoined.self.id);
  assert.equal(resumedParticipant.self.role, 'participant');
  const deniedPlayback = once(participantReplacement, 'action_rejected');
  participantReplacement.emit('playback', { roomId: created.roomId, type: 'pause', time: 8 });
  assert.match((await deniedPlayback).message, /Only a host or moderator/);
  assert.equal(room.getParticipant(participantOldSocketId), undefined);

  const disconnected = once(participantReplacement, 'disconnect', 'network disconnect');
  participantReplacement.disconnect();
  await disconnected;
  await delay();
  assert.equal(room.getParticipantById(participantJoined.self.id).connected, false);
  const networkReconnection = await connect();
  const reconnectedParticipant = await emit(networkReconnection, 'resume_room', {
    roomId: created.roomId,
    sessionToken: participantJoined.self.sessionToken,
  });
  assert.equal(reconnectedParticipant.self.id, participantJoined.self.id);
  assert.equal(reconnectedParticipant.self.role, 'participant');
  assert.equal(room.participants.size, 3);

  const otherHost = await connect();
  const otherRoom = await emit(otherHost, 'create_room', { username: 'IsolatedRecoveryHost' });
  let roomLeaked = false;
  moderatorSocket.once('sync_state', () => { roomLeaked = true; });
  otherHost.emit('playback', { roomId: otherRoom.roomId, type: 'play', time: 1 });
  await delay();
  assert.equal(roomLeaked, false, 'recovered members remain isolated to their original room');

  const expiringParticipant = await connect();
  const expiringJoin = await emit(expiringParticipant, 'join_room', {
    roomId: created.roomId,
    username: 'ExpiringParticipant',
  });
  const expiryObserved = once(expiringParticipant, 'disconnect', 'expired participant disconnect');
  expiringParticipant.disconnect();
  await expiryObserved;
  await delay();
  const expiringMember = room.getParticipantById(expiringJoin.self.id);
  expiringMember.disconnectedAt = Date.now() - (16 * 60 * 1000);
  const expiredSession = await emit(await connect(), 'resume_room', {
    roomId: created.roomId,
    sessionToken: expiringJoin.self.sessionToken,
  });
  assert.equal(expiredSession.code, 'SESSION_EXPIRED');
  assert.equal(room.getParticipantById(expiringJoin.self.id), undefined);
});

test('video changes preserve authoritative playback state for members and reconnects', async (t) => {
  const server = createPartyServer({ serveClient: false, dbPath: ':memory:' });
  await new Promise((resolve) => server.httpServer.listen(0, resolve));
  const url = `http://127.0.0.1:${server.httpServer.address().port}`;
  const sockets = [];
  const connect = async () => {
    const socket = client(url, { transports: ['websocket'], forceNew: true });
    sockets.push(socket);
    await once(socket, 'connect');
    return socket;
  };
  t.after(async () => {
    sockets.forEach((socket) => socket.close());
    await server.close();
  });

  const host = await connect();
  const created = await emit(host, 'create_room', { username: 'VideoHost', videoId: VIDEO_A });
  const moderator = await connect();
  const moderatorJoin = await emit(moderator, 'join_room', {
    roomId: created.roomId,
    username: 'VideoModerator',
  });
  const participant = await connect();
  const participantJoin = await emit(participant, 'join_room', {
    roomId: created.roomId,
    username: 'VideoParticipant',
  });
  const members = [host, moderator, participant];

  const roleUpdate = once(host, 'participants_updated');
  host.emit('assign_role', {
    roomId: created.roomId,
    userId: moderatorJoin.self.id,
    role: 'moderator',
  });
  await roleUpdate;

  const playingEvents = members.map((socket) => once(socket, 'sync_state'));
  host.emit('playback', { roomId: created.roomId, type: 'play', time: 23 });
  const playingStates = await Promise.all(playingEvents);
  assert.ok(playingStates.every((state) => state.isPlaying));

  const playingVideoEvents = members.map((socket) => once(socket, 'sync_state'));
  host.emit('playback', { roomId: created.roomId, type: 'video', videoId: VIDEO_B });
  const playingVideoStates = await Promise.all(playingVideoEvents);
  assert.ok(playingVideoStates.every((state) =>
    state.videoId === VIDEO_B && state.isPlaying && state.currentTime < 1
  ));

  const rejectedChange = once(participant, 'action_rejected');
  participant.emit('playback', { roomId: created.roomId, type: 'video', videoId: VIDEO_C });
  assert.match((await rejectedChange).message, /Only a host or moderator/);
  assert.equal(server.rooms.get(created.roomId).state.videoId, VIDEO_B);

  const moderatorVideoEvents = members.map((socket) => once(socket, 'sync_state'));
  moderator.emit('change_video', { roomId: created.roomId, videoId: VIDEO_C });
  const moderatorVideoStates = await Promise.all(moderatorVideoEvents);
  assert.ok(moderatorVideoStates.every((state) =>
    state.videoId === VIDEO_C && state.isPlaying
  ));

  const pausedEvents = members.map((socket) => once(socket, 'sync_state'));
  host.emit('playback', { roomId: created.roomId, type: 'pause', time: 48 });
  assert.ok((await Promise.all(pausedEvents)).every((state) => !state.isPlaying));

  const pausedVideoEvents = members.map((socket) => once(socket, 'sync_state'));
  host.emit('playback', { roomId: created.roomId, type: 'video', videoId: VIDEO_A });
  const pausedVideoStates = await Promise.all(pausedVideoEvents);
  assert.ok(pausedVideoStates.every((state) =>
    state.videoId === VIDEO_A && !state.isPlaying && state.currentTime === 0
  ));

  const rapidFirstEvents = members.map((socket) => once(socket, 'sync_state'));
  moderator.emit('playback', { roomId: created.roomId, type: 'video', videoId: VIDEO_B });
  const rapidFirst = await Promise.all(rapidFirstEvents);
  const rapidSecondEvents = members.map((socket) => once(socket, 'sync_state'));
  moderator.emit('playback', { roomId: created.roomId, type: 'video', videoId: VIDEO_C });
  const rapidSecond = await Promise.all(rapidSecondEvents);
  assert.ok(rapidSecond.every((state, index) =>
    state.videoId === VIDEO_C &&
    state.isPlaying === false &&
    state.revision > rapidFirst[index].revision
  ));

  const lateJoiner = await connect();
  const lateState = await emit(lateJoiner, 'join_room', {
    roomId: created.roomId,
    username: 'LateVideoViewer',
  });
  assert.equal(lateState.state.videoId, VIDEO_C);
  assert.equal(lateState.state.isPlaying, false);

  const participantDisconnected = once(participant, 'disconnect');
  participant.disconnect();
  await participantDisconnected;
  const reconnectedParticipant = await connect();
  const resumed = await emit(reconnectedParticipant, 'resume_room', {
    roomId: created.roomId,
    sessionToken: participantJoin.self.sessionToken,
  });
  assert.equal(resumed.state.videoId, VIDEO_C);
  assert.equal(resumed.state.isPlaying, false);
  assert.equal(resumed.self.role, 'participant');
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
  assert.equal(joinedEvent.participant.id, joined.self.id);
  assert.equal(Object.hasOwn(joinedEvent, 'participants'), false);

  // Test direct play event
  const playPromise = once(guest, 'sync_state');
  host.emit('play', { roomId: room.roomId, time: 20 });
  const playState = await playPromise;
  assert.equal(playState.isPlaying, true);
  assert.ok(Math.abs(playState.currentTime - 20) < 0.1);

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
  assert.equal(vidState.isPlaying, false);

  // Test reaction event
  const reactionPromise = once(host, 'reaction');
  guest.emit('reaction', { roomId: room.roomId, emoji: '🔥' });
  const reactionData = await reactionPromise;
  assert.equal(reactionData.emoji, '🔥');
  assert.equal(reactionData.username, 'GuestUser');
  const invalidReaction = once(guest, 'action_rejected');
  guest.emit('reaction', { roomId: room.roomId, emoji: '<script>' });
  assert.match((await invalidReaction).message, /Invalid reaction/);

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

  const succession = once(host, 'host_changed');
  guest.disconnect();
  assert.equal((await succession).userId, room.self.id);
});

test('host transfer preserves playback, synchronizes new controls, and retains RBAC after recovery', async (t) => {
  const server = createPartyServer({ serveClient: false, dbPath: ':memory:' });
  await new Promise((resolve) => server.httpServer.listen(0, resolve));
  const url = `http://127.0.0.1:${server.httpServer.address().port}`;
  const sockets = [];
  const connect = async () => {
    const socket = client(url, { transports: ['websocket'], forceNew: true });
    sockets.push(socket);
    await once(socket, 'connect');
    return socket;
  };
  t.after(async () => {
    sockets.forEach((socket) => socket.close());
    await server.close();
  });

  const host = await connect();
  const room = await emit(host, 'create_room', { username: 'TransferHost', videoId: VIDEO_A });
  const nextHost = await connect();
  const nextHostJoin = await emit(nextHost, 'join_room', {
    roomId: room.roomId,
    username: 'NextHost',
  });
  const moderator = await connect();
  const moderatorJoin = await emit(moderator, 'join_room', {
    roomId: room.roomId,
    username: 'TransferModerator',
  });
  const participant = await connect();
  const participantJoin = await emit(participant, 'join_room', {
    roomId: room.roomId,
    username: 'TransferViewer',
  });

  const moderatorUpdated = once(moderator, 'participants_updated');
  host.emit('assign_role', {
    roomId: room.roomId,
    userId: moderatorJoin.self.id,
    role: 'moderator',
  });
  assert.equal((await moderatorUpdated).find((person) => person.id === moderatorJoin.self.id).role, 'moderator');

  const playingForHost = once(host, 'sync_state');
  host.emit('play', { roomId: room.roomId, time: 20 });
  const playingState = await playingForHost;
  assert.equal(playingState.isPlaying, true);
  const roomState = server.rooms.get(room.roomId);
  const revisionBeforeTransfer = roomState.state.revision;

  const transferEvents = [
    once(host, 'role_assigned'),
    once(nextHost, 'role_assigned'),
    once(moderator, 'role_assigned'),
    once(participant, 'role_assigned'),
  ];
  host.emit('transfer_host', { roomId: room.roomId, userId: nextHostJoin.self.id });
  await Promise.all(transferEvents);
  assert.equal(roomState.state.revision, revisionBeforeTransfer);
  assert.equal(roomState.state.videoId, VIDEO_A);
  assert.equal(roomState.state.isPlaying, true);
  assert.equal(roomState.getParticipantById(room.self.id).role, 'moderator');
  assert.equal(roomState.getParticipantById(nextHostJoin.self.id).role, 'host');
  assert.equal(roomState.getParticipantById(moderatorJoin.self.id).role, 'moderator');
  assert.equal(roomState.getParticipantById(participantJoin.self.id).role, 'participant');

  const pauseEvents = [once(host, 'sync_state'), once(moderator, 'sync_state'), once(participant, 'sync_state')];
  nextHost.emit('pause', { roomId: room.roomId, time: 25 });
  const pausedStates = await Promise.all(pauseEvents);
  assert.ok(pausedStates.every((state) => state.isPlaying === false && state.videoId === VIDEO_A));

  const seekEvents = [once(host, 'sync_state'), once(moderator, 'sync_state'), once(participant, 'sync_state')];
  nextHost.emit('seek', { roomId: room.roomId, time: 60 });
  const seekStates = await Promise.all(seekEvents);
  assert.ok(seekStates.every((state) => state.currentTime === 60 && state.isPlaying === false));

  const transferBackEvents = [once(host, 'role_assigned'), once(nextHost, 'role_assigned')];
  nextHost.emit('transfer_host', { roomId: room.roomId, userId: room.self.id });
  await Promise.all(transferBackEvents);
  assert.equal(roomState.state.videoId, VIDEO_A);
  assert.equal(roomState.state.currentTime, 60);
  assert.equal(roomState.state.isPlaying, false);
  assert.equal(roomState.getParticipantById(room.self.id).role, 'host');
  assert.equal(roomState.getParticipantById(nextHostJoin.self.id).role, 'moderator');

  const playEvents = [once(nextHost, 'sync_state'), once(moderator, 'sync_state'), once(participant, 'sync_state')];
  host.emit('play', { roomId: room.roomId, time: 60 });
  const resumedPlayback = await Promise.all(playEvents);
  assert.ok(resumedPlayback.every((state) => state.isPlaying && state.videoId === VIDEO_A));

  const rejectedParticipantAction = once(participant, 'action_rejected');
  participant.emit('pause', { roomId: room.roomId, time: 60 });
  assert.match((await rejectedParticipantAction).message, /Only a host or moderator/);
  const stateBeforeModeratorAction = roomState.state.revision;
  const moderatorPlayback = once(host, 'sync_state');
  moderator.emit('pause', { roomId: room.roomId, time: 62 });
  assert.equal((await moderatorPlayback).isPlaying, false);
  assert.equal(roomState.state.revision, stateBeforeModeratorAction + 1);

  const recoveredHost = await connect();
  const recovered = await emit(recoveredHost, 'resume_room', {
    roomId: room.roomId,
    sessionToken: room.self.sessionToken,
  });
  assert.equal(recovered.self.id, room.self.id);
  assert.equal(recovered.self.role, 'host');
  assert.equal(recovered.state.videoId, VIDEO_A);
  assert.equal(recovered.state.currentTime, 62);
  assert.equal(recovered.state.isPlaying, false);
  assert.equal(host.connected, false);
  const recoveredHostSync = once(moderator, 'sync_state');
  recoveredHost.emit('play', { roomId: room.roomId, time: 62 });
  assert.equal((await recoveredHostSync).isPlaying, true);
});

test('participants must request approval before playback changes take effect', async (t) => {
  const server = createPartyServer({ serveClient: false, dbPath: ':memory:' });
  await new Promise((resolve) => server.httpServer.listen(0, resolve));
  const url = `http://127.0.0.1:${server.httpServer.address().port}`;
  const sockets = [];
  const connect = async () => {
    const socket = client(url, { transports: ['websocket'], forceNew: true });
    sockets.push(socket);
    await once(socket, 'connect');
    return socket;
  };
  t.after(async () => {
    sockets.forEach((socket) => socket.close());
    await server.close();
  });

  const host = await connect();
  const room = await emit(host, 'create_room', { username: 'ApprovingHost', videoId: VIDEO_A });
  const participant = await connect();
  const joined = await emit(participant, 'join_room', {
    roomId: room.roomId,
    username: 'RequestingViewer',
  });
  const moderator = await connect();
  const moderatorRoom = await emit(moderator, 'join_room', {
    roomId: room.roomId,
    username: 'ApprovingModerator',
  });
  const moderatorRole = once(moderator, 'participants_updated');
  host.emit('assign_role', {
    roomId: room.roomId,
    userId: moderatorRoom.self.id,
    role: 'moderator',
  });
  await moderatorRole;

  assert.deepEqual((await emit(participant, 'request_playback_change', {
    roomId: room.roomId,
    type: 'video',
    videoId: 'invalid',
  })).error, 'Enter a valid YouTube video ID or link.');

  const hostRequest = once(host, 'playback_change_requested');
  const moderatorRequest = once(moderator, 'playback_change_requested');
  const noRequestToOtherParticipants = new Promise((resolve) => {
    participant.once('playback_change_requested', resolve);
    setTimeout(() => resolve(null), 40);
  });
  const result = await emit(participant, 'request_playback_change', {
    roomId: room.roomId,
    type: 'video',
    videoId: VIDEO_B,
  });
  assert.ok(result.requestId);
  const pendingForHost = await hostRequest;
  assert.equal(pendingForHost.requesterId, joined.self.id);
  assert.equal((await moderatorRequest).id, pendingForHost.id);
  assert.equal(await noRequestToOtherParticipants, null);
  assert.equal(server.rooms.get(room.roomId).state.videoId, VIDEO_A);

  const lateModerator = await connect();
  const lateModeratorRoom = await emit(lateModerator, 'join_room', {
    roomId: room.roomId,
    username: 'LateModerator',
  });
  const pendingForNewModerator = once(lateModerator, 'pending_playback_requests');
  host.emit('assign_role', {
    roomId: room.roomId,
    userId: lateModeratorRoom.self.id,
    role: 'moderator',
  });
  assert.equal((await pendingForNewModerator).some((request) => request.id === result.requestId), true);

  const unauthorizedApproval = once(participant, 'action_rejected');
  participant.emit('resolve_playback_request', {
    roomId: room.roomId,
    requestId: result.requestId,
    decision: 'approve',
  });
  assert.match((await unauthorizedApproval).message, /Only the host or a moderator/);
  assert.equal(server.rooms.get(room.roomId).state.videoId, VIDEO_A);

  const declined = once(participant, 'playback_request_result');
  const moderatorDeclined = once(moderator, 'playback_request_resolved');
  host.emit('resolve_playback_request', {
    roomId: room.roomId,
    requestId: result.requestId,
    decision: 'reject',
  });
  assert.equal((await declined).decision, 'reject');
  assert.equal((await moderatorDeclined).decision, 'reject');
  assert.equal(server.rooms.get(room.roomId).state.videoId, VIDEO_A);

  const approvalRequest = once(host, 'playback_change_requested');
  const approval = await emit(participant, 'request_playback_change', {
    roomId: room.roomId,
    type: 'seek',
    time: 87.5,
  });
  const approvalPending = await approvalRequest;
  assert.equal(approvalPending.action.time, 87.5);
  const synchronized = once(participant, 'sync_state');
  const approved = once(participant, 'playback_request_result');
  host.emit('resolve_playback_request', {
    roomId: room.roomId,
    requestId: approval.requestId,
    decision: 'approve',
  });
  assert.equal((await approved).decision, 'approve');
  const state = await synchronized;
  assert.ok(Math.abs(state.currentTime - 87.5) < 0.1);
  assert.equal(server.rooms.get(room.roomId).state.revision, 1);
  assert.equal(server.socketHandler.playbackRequestTimers.has(approval.requestId), false);

  const expiryParticipant = await connect();
  await emit(expiryParticipant, 'join_room', {
    roomId: room.roomId,
    username: 'ExpiryViewer',
  });
  const expiryNotice = once(host, 'playback_change_requested');
  const expiredResult = once(expiryParticipant, 'playback_request_result');
  const expirationResolution = once(host, 'playback_request_resolved');
  const expiryRequest = await emit(expiryParticipant, 'request_playback_change', {
    roomId: room.roomId,
    type: 'pause',
  });
  await expiryNotice;
  server.socketHandler.expirePlaybackRequest(room.roomId, expiryRequest.requestId);
  assert.equal((await expiredResult).decision, 'expired');
  assert.equal((await expirationResolution).decision, 'expired');
  assert.equal(server.socketHandler.playbackRequests.has(room.roomId), false);
  assert.equal(server.socketHandler.playbackRequestTimers.has(expiryRequest.requestId), false);
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

test('health endpoint identifies in-memory SQLite as degraded persistence', async (t) => {
  const server = createPartyServer({ serveClient: false, dbPath: ':memory:' });
  await new Promise((resolve) => server.httpServer.listen(0, resolve));
  t.after(() => server.close());

  const response = await fetch(`http://127.0.0.1:${server.httpServer.address().port}/api/health`);
  const health = await response.json();
  assert.equal(health.persistence, 'sqlite-memory');
  assert.equal(health.persistenceDegraded, true);
  assert.equal(response.status, process.env.NODE_ENV === 'production' ? 503 : 200);
});

test('metrics endpoint exposes aggregate counters without room or participant identifiers', async (t) => {
  const previousToken = process.env.METRICS_TOKEN;
  process.env.METRICS_TOKEN = 'test-metrics-token';
  const server = createPartyServer({ serveClient: false, dbPath: ':memory:' });
  await new Promise((resolve) => server.httpServer.listen(0, resolve));
  const url = `http://127.0.0.1:${server.httpServer.address().port}/api/metrics`;
  t.after(async () => {
    await server.close();
    if (previousToken === undefined) delete process.env.METRICS_TOKEN;
    else process.env.METRICS_TOKEN = previousToken;
  });

  assert.equal((await fetch(url)).status, 401);
  assert.equal((await fetch(url, { headers: { authorization: 'test-metrics-token' } })).status, 401);
  const socket = client(url.replace('/api/metrics', ''), { transports: ['websocket'], forceNew: true });
  await once(socket, 'connect');
  const room = await emit(socket, 'create_room', { username: 'MetricsHost' });
  const response = await fetch(url, { headers: { authorization: 'Bearer test-metrics-token' } });
  const metrics = await response.json();
  assert.equal(response.status, 200);
  assert.equal(metrics.activeRooms, 1);
  assert.equal(metrics.activeConnections, 1);
  assert.equal(metrics.counters.roomsCreated, 1);
  assert.equal(metrics.counters.participantsJoined, 1);
  assert.equal(JSON.stringify(metrics).includes(room.roomId), false);
  socket.close();
});

test('socket origin allowlist and connection limits reject untrusted or excess clients', async (t) => {
  const server = createPartyServer({
    serveClient: false,
    dbPath: ':memory:',
    clientOrigin: 'https://allowed.example',
    limits: { maxConnections: 1, maxConnectionsPerAddress: 1 },
  });
  await new Promise((resolve) => server.httpServer.listen(0, resolve));
  const url = `http://127.0.0.1:${server.httpServer.address().port}`;
  const sockets = [];
  t.after(async () => {
    sockets.forEach((socket) => socket.close());
    await server.close();
  });

  const untrusted = client(url, {
    transports: ['websocket'],
    forceNew: true,
    reconnection: false,
    extraHeaders: { origin: 'https://untrusted.example' },
  });
  sockets.push(untrusted);
  const originError = await once(untrusted, 'connect_error');
  assert.ok(originError);

  const accepted = client(url, {
    transports: ['websocket'],
    forceNew: true,
    extraHeaders: { origin: 'https://allowed.example' },
  });
  sockets.push(accepted);
  await once(accepted, 'connect');

  const excess = client(url, {
    transports: ['websocket'],
    forceNew: true,
    extraHeaders: { origin: 'https://allowed.example' },
  });
  sockets.push(excess);
  const disconnected = once(excess, 'disconnect');
  await disconnected;
  assert.equal(server.metrics.counters.connectionsAccepted, 1);
  assert.equal(server.metrics.counters.connectionsRejected, 1);
});
