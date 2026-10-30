import { io } from 'socket.io-client';
import assert from 'node:assert/strict';

const SERVER_URL = 'http://localhost:3005';
const VIDEO_1 = 'dQw4w9WgXcQ';
const VIDEO_2 = 'jNQXAC9IVRw';

const delay = (ms = 50) => new Promise((resolve) => setTimeout(resolve, ms));
const once = (socket, event) => new Promise((resolve) => socket.once(event, resolve));
const emit = (socket, event, data) => new Promise((resolve) => socket.emit(event, data, resolve));

async function runComprehensiveAudit() {
  console.log('===============================================================');
  console.log('  SYNCSPACE COMPREHENSIVE MULTI-SESSION & CONCURRENCY AUDIT');
  console.log('===============================================================\n');

  const sockets = [];
  const connect = async () => {
    const s = io(SERVER_URL, { transports: ['websocket'], forceNew: true, reconnection: false });
    sockets.push(s);
    await once(s, 'connect');
    return s;
  };

  try {
    // -------------------------------------------------------------
    // Test 1: Health endpoint check
    // -------------------------------------------------------------
    console.log('▶ Test 1: Verifying Server Health Endpoint...');
    const healthRes = await fetch(`${SERVER_URL}/api/health`);
    const healthData = await healthRes.json();
    assert.equal(healthRes.status, 200);
    assert.equal(healthData.ok, true);
    assert.equal(healthData.service, 'syncspace-watch-party');
    console.log(`  ✓ Health endpoint responsive: ${JSON.stringify(healthData)}`);

    // -------------------------------------------------------------
    // Test 2: Room creation & 6-char code validation
    // -------------------------------------------------------------
    console.log('\n▶ Test 2: Room Creation & Creator Host Assignment...');
    const hostA = await connect();
    const roomAData = await emit(hostA, 'create_room', { username: 'AliceHost', videoId: VIDEO_1 });
    assert.match(roomAData.roomId, /^[A-Z0-9]{6}$/, 'Room code must be 6 alphanumeric chars');
    assert.equal(roomAData.self.role, 'host', 'Creator must be Host');
    assert.equal(roomAData.state.videoId, VIDEO_1);
    assert.equal(roomAData.state.playState, 'PAUSED');
    console.log(`  ✓ Room created with code ${roomAData.roomId}; Creator assigned role 'host'`);

    // -------------------------------------------------------------
    // Test 3: Multiple joins & Participant default role
    // -------------------------------------------------------------
    console.log('\n▶ Test 3: Participant Joining & Default Watch-Only Role...');
    const guest1 = await connect();
    const guest1Data = await emit(guest1, 'join_room', { roomId: roomAData.roomId, username: 'BobParticipant' });
    assert.equal(guest1Data.self.role, 'participant', 'Joining member must be participant');
    assert.equal(guest1Data.state.videoId, VIDEO_1);

    const guest2 = await connect();
    const guest2Data = await emit(guest2, 'join_room', { roomId: roomAData.roomId, username: 'CharlieGuest' });
    assert.equal(guest2Data.self.role, 'participant');
    console.log('  ✓ Participants joined with default role and received initial room state');

    // -------------------------------------------------------------
    // Test 4: Real-time Playback Synchronization (Play, Pause, Seek)
    // -------------------------------------------------------------
    console.log('\n▶ Test 4: Real-Time Playback Synchronization (Play, Pause, Seek)...');
    let playSyncPromise = once(guest1, 'sync_state');
    hostA.emit('play', { roomId: roomAData.roomId, currentTime: 10 });
    let played = await playSyncPromise;
    assert.equal(played.isPlaying, true);
    assert.equal(played.playState, 'PLAYING');
    assert.equal(played.currentTime, 10);

    let seekSyncPromise = once(guest1, 'sync_state');
    hostA.emit('seek', { roomId: roomAData.roomId, currentTime: 45 });
    let seeked = await seekSyncPromise;
    assert.equal(seeked.currentTime, 45);

    let pauseSyncPromise = once(guest1, 'sync_state');
    hostA.emit('pause', { roomId: roomAData.roomId, currentTime: 45 });
    let paused = await pauseSyncPromise;
    assert.equal(paused.isPlaying, false);
    assert.equal(paused.playState, 'PAUSED');
    console.log('  ✓ Play, Seek, and Pause synchronized across all participants with playState');

    // -------------------------------------------------------------
    // Test 5: Authorization Enforcement (Participant unpermitted actions rejected)
    // -------------------------------------------------------------
    console.log('\n▶ Test 5: Server-Side Authorization Enforcement...');
    const rejectedPromise = once(guest1, 'action_rejected');
    guest1.emit('play', { roomId: roomAData.roomId, currentTime: 50 });
    const rejectData = await rejectedPromise;
    assert.match(rejectData.message, /Only a host or moderator/, 'Participant play attempt must be rejected');

    const rejectChangeVid = once(guest2, 'action_rejected');
    guest2.emit('change_video', { roomId: roomAData.roomId, videoId: VIDEO_2 });
    assert.match((await rejectChangeVid).message, /Only a host or moderator/);
    console.log('  ✓ Unauthorized playback/video commands strictly rejected by backend');

    // -------------------------------------------------------------
    // Test 6: Role Promotion to Moderator & Moderator Playback Rights
    // -------------------------------------------------------------
    console.log('\n▶ Test 6: Moderator Promotion & Privileged Playback Rights...');
    const promoPromise = once(guest1, 'role_assigned');
    hostA.emit('assign_role', { roomId: roomAData.roomId, userId: guest1Data.self.id, role: 'moderator' });
    const promoEvent = await promoPromise;
    assert.equal(promoEvent.role, 'moderator');
    assert.equal(promoEvent.userId, guest1Data.self.id);

    // Moderator can now change video
    const changeVidPromise = once(hostA, 'sync_state');
    guest1.emit('change_video', { roomId: roomAData.roomId, videoId: VIDEO_2 });
    const vidSync = await changeVidPromise;
    assert.equal(vidSync.videoId, VIDEO_2);
    console.log('  ✓ Participant promoted to Moderator and successfully controlled playback');

    // -------------------------------------------------------------
    // Test 7: Host Transfer Ownership
    // -------------------------------------------------------------
    console.log('\n▶ Test 7: Host Transfer Ownership...');
    const transferPromise = once(guest1, 'role_assigned');
    hostA.emit('transfer_host', { roomId: roomAData.roomId, userId: guest1Data.self.id });
    const transferEvent = await transferPromise;
    assert.equal(transferEvent.role, 'host');
    assert.equal(transferEvent.userId, guest1Data.self.id);
    console.log('  ✓ Host ownership successfully transferred to Bob (Guest1)');

    // -------------------------------------------------------------
    // Test 8: Multiple Rooms Concurrency & Room Isolation
    // -------------------------------------------------------------
    console.log('\n▶ Test 8: Multiple Rooms Concurrency & Isolation...');
    const hostB = await connect();
    const roomBData = await emit(hostB, 'create_room', { username: 'RoomBHost', videoId: VIDEO_1 });

    let roomBLeakedToRoomA = false;
    guest2.once('sync_state', () => { roomBLeakedToRoomA = true; });

    const roomBSyncPromise = once(hostB, 'sync_state');
    hostB.emit('play', { roomId: roomBData.roomId, currentTime: 99 });
    await roomBSyncPromise;
    await delay(100);

    assert.equal(roomBLeakedToRoomA, false, 'Events in Room B must never leak to Room A');
    console.log('  ✓ Room isolation verified: concurrent rooms operate independently without cross-talk');

    // -------------------------------------------------------------
    // Test 9: Reconnection & Session Recovery via Session Token
    // -------------------------------------------------------------
    console.log('\n▶ Test 9: Reconnection & Session Recovery...');
    guest2.disconnect();
    await delay(100);

    const guest2Recon = await connect();
    const resumeRes = await emit(guest2Recon, 'resume_room', {
      roomId: roomAData.roomId,
      sessionToken: guest2Data.self.sessionToken,
    });
    assert.equal(resumeRes.self.username, 'CharlieGuest');
    assert.equal(resumeRes.self.id, guest2Data.self.id);
    assert.equal(resumeRes.state.videoId, VIDEO_2);
    console.log('  ✓ Reconnected user successfully resumed session using private session token');

    // -------------------------------------------------------------
    // Test 10: Chat Messaging, Rate Limiting & Emoji Reactions
    // -------------------------------------------------------------
    console.log('\n▶ Test 10: Chat Messaging, Rate Limiting & Emoji Reactions...');
    const chatPromise = once(guest2Recon, 'chat_message');
    guest1.emit('chat', { roomId: roomAData.roomId, text: 'Watching the party together!' });
    const chatMsg = await chatPromise;
    assert.equal(chatMsg.text, 'Watching the party together!');
    assert.equal(chatMsg.username, 'BobParticipant');

    const rxPromise = once(guest2Recon, 'reaction');
    guest1.emit('reaction', { roomId: roomAData.roomId, emoji: '🔥' });
    const rxMsg = await rxPromise;
    assert.equal(rxMsg.emoji, '🔥');
    assert.equal(rxMsg.username, 'BobParticipant');

    // Flooding chat triggers rate limiting
    let rateLimited = false;
    guest1.on('chat_rate_limited', () => { rateLimited = true; });
    for (let i = 0; i < 7; i++) {
      guest1.emit('chat', { roomId: roomAData.roomId, text: `Spam ${i}` });
    }
    await delay(150);
    assert.equal(rateLimited, true, 'Chat flood must trigger rate limit response');
    console.log('  ✓ Chat broadcast, emoji reactions, and chat rate limiting verified');

    console.log('\n===============================================================');
    console.log('  ✓ ALL 10 COMPREHENSIVE REAL-WORLD TESTS PASSED PERFECTLY!');
    console.log('===============================================================\n');
  } finally {
    sockets.forEach((s) => s.close());
  }
}

runComprehensiveAudit().catch((err) => {
  console.error('\n❌ Comprehensive audit failed:', err);
  process.exit(1);
});
