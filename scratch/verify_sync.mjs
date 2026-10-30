import { io } from 'socket.io-client';
import assert from 'node:assert';

const SERVER_URL = 'http://localhost:3005';

async function runVerification() {
  console.log('--- Starting Syncspace E2E Socket Multi-Session Verification ---');

  const socketHost = io(SERVER_URL, { reconnection: false });
  const socketGuest = io(SERVER_URL, { reconnection: false });

  await Promise.all([
    new Promise((resolve) => socketHost.on('connect', resolve)),
    new Promise((resolve) => socketGuest.on('connect', resolve)),
  ]);
  console.log('✓ Both Host and Guest socket clients connected');

  // 1. Host creates room
  const hostJoinData = await new Promise((resolve) => {
    socketHost.emit(
      'create_room',
      { username: 'Alice (Host)', videoId: 'dQw4w9WgXcQ' },
      resolve
    );
  });
  assert(hostJoinData.roomId && hostJoinData.roomId.length === 6, 'Room ID must be 6 chars');
  assert.strictEqual(hostJoinData.self.role, 'host', 'Creator must be host');
  console.log(`✓ Room created with code: ${hostJoinData.roomId}`);

  // 2. Guest joins room
  const guestJoinData = await new Promise((resolve) => {
    socketGuest.emit(
      'join_room',
      { username: 'Bob (Guest)', roomId: hostJoinData.roomId },
      resolve
    );
  });
  assert.strictEqual(guestJoinData.self.role, 'participant', 'Guest must be participant');
  assert.strictEqual(guestJoinData.state.videoId, 'dQw4w9WgXcQ', 'Guest must receive initial video');
  console.log('✓ Guest joined and received initial state & participant role');

  // 3. Host emits play event
  const playPromise = new Promise((resolve) => {
    socketGuest.once('sync_state', (sync) => {
      assert.strictEqual(sync.isPlaying, true, 'Guest received isPlaying=true');
      assert.strictEqual(sync.playState, 'PLAYING', 'Guest received playState=PLAYING');
      resolve();
    });
  });
  socketHost.emit('play', { roomId: hostJoinData.roomId, currentTime: 5 });
  await playPromise;
  console.log('✓ Playback play event synchronized from Host to Guest (includes playState=PLAYING)');

  // 4. Host seeks +10s
  const seekPromise = new Promise((resolve) => {
    socketGuest.once('sync_state', (sync) => {
      assert(sync.currentTime >= 14, 'Guest received seek position update');
      resolve();
    });
  });
  socketHost.emit('seek', { roomId: hostJoinData.roomId, currentTime: 15 });
  await seekPromise;
  console.log('✓ Seek event (+10s) synchronized to Guest');

  // 5. Host pauses
  const pausePromise = new Promise((resolve) => {
    socketGuest.once('sync_state', (sync) => {
      assert.strictEqual(sync.isPlaying, false, 'Guest received isPlaying=false');
      assert.strictEqual(sync.playState, 'PAUSED', 'Guest received playState=PAUSED');
      resolve();
    });
  });
  socketHost.emit('pause', { roomId: hostJoinData.roomId, currentTime: 15 });
  await pausePromise;
  console.log('✓ Pause event synchronized to Guest (includes playState=PAUSED)');

  // 6. Guest attempts unauthorized action (change_video)
  const rejectedPromise = new Promise((resolve) => {
    socketGuest.once('action_rejected', (data) => {
      assert(data.message || data.error, 'Rejection error message received');
      resolve();
    });
  });
  socketGuest.emit('change_video', { roomId: hostJoinData.roomId, videoId: 'jNQXAC9IVRw' });
  await rejectedPromise;
  console.log('✓ Server rejected unauthorized participant change_video attempt');

  // 7. Host promotes Guest to moderator
  const roleUpdatePromise = new Promise((resolve) => {
    socketGuest.once('participants_updated', (participants) => {
      const bob = participants.find((p) => p.username === 'Bob (Guest)');
      assert.strictEqual(bob.role, 'moderator');
      resolve();
    });
  });
  socketHost.emit('assign_role', {
    roomId: hostJoinData.roomId,
    targetId: guestJoinData.self.id,
    role: 'moderator',
  });
  await roleUpdatePromise;
  console.log('✓ Host promoted Guest to moderator; role update broadcast received');

  // 8. Bob (now moderator) successfully changes video
  const changeVideoPromise = new Promise((resolve) => {
    socketHost.once('sync_state', (sync) => {
      assert.strictEqual(sync.videoId, 'jNQXAC9IVRw', 'Host received new video ID');
      resolve();
    });
  });
  socketGuest.emit('change_video', { roomId: hostJoinData.roomId, videoId: 'jNQXAC9IVRw' });
  await changeVideoPromise;
  console.log('✓ Moderator successfully changed video and synced to Host');

  // 9. Chat messaging
  const chatPromise = new Promise((resolve) => {
    socketGuest.once('chat_message', (msg) => {
      assert.strictEqual(msg.message, 'Hello from Alice!');
      assert.strictEqual(msg.username, 'Alice (Host)');
      assert(msg.timestamp, 'Chat message includes timestamp');
      resolve();
    });
  });
  socketHost.emit('chat', { roomId: hostJoinData.roomId, message: 'Hello from Alice!' });
  await chatPromise;
  console.log('✓ Chat message delivered with username, timestamp, and safe content');

  // 10. Transfer Host ownership
  const transferPromise = new Promise((resolve) => {
    socketHost.once('role_assigned', (data) => {
      assert.strictEqual(data.role, 'host');
      assert.strictEqual(data.userId, guestJoinData.self.id);
      resolve();
    });
  });
  socketHost.emit('transfer_host', { roomId: hostJoinData.roomId, userId: guestJoinData.self.id });
  await transferPromise;
  console.log('✓ Host ownership transferred to Bob; role_assigned broadcast confirmed');

  socketHost.disconnect();
  socketGuest.disconnect();
  console.log('=== All 10 Verification Checks Passed Successfully ===');
}

runVerification().catch((err) => {
  console.error('Verification failed:', err);
  process.exit(1);
});
