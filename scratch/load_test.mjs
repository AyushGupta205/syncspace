import { io } from 'socket.io-client';
import assert from 'node:assert/strict';

const SERVER_URL = 'http://localhost:3005';
const NUM_ROOMS = 5;
const CLIENTS_PER_ROOM = 10; // 50 concurrent socket connections total
const TOTAL_CLIENTS = NUM_ROOMS * CLIENTS_PER_ROOM;

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const once = (socket, event) => new Promise((resolve) => socket.once(event, resolve));
const emit = (socket, event, data) => new Promise((resolve) => socket.emit(event, data, resolve));

async function runLoadSimulation() {
  console.log(`\n--- Starting Controlled Concurrency Test (${NUM_ROOMS} rooms, ${TOTAL_CLIENTS} concurrent clients) ---`);
  const startTime = Date.now();
  const allSockets = [];

  try {
    for (let r = 0; r < NUM_ROOMS; r++) {
      const hostSocket = io(SERVER_URL, { transports: ['websocket'], forceNew: true });
      allSockets.push(hostSocket);
      await once(hostSocket, 'connect');

      const roomData = await emit(hostSocket, 'create_room', {
        username: `Host_R${r}`,
        videoId: 'dQw4w9WgXcQ',
      });
      assert(roomData.roomId);

      // Connect participants
      const guestPromises = [];
      for (let c = 1; c < CLIENTS_PER_ROOM; c++) {
        const guestSocket = io(SERVER_URL, { transports: ['websocket'], forceNew: true });
        allSockets.push(guestSocket);
        guestPromises.push(
          (async () => {
            await once(guestSocket, 'connect');
            const joinRes = await emit(guestSocket, 'join_room', {
              roomId: roomData.roomId,
              username: `Guest_R${r}_C${c}`,
            });
            assert(joinRes.self);
          })()
        );
      }
      await Promise.all(guestPromises);
      process.stdout.write(`  [Room ${r + 1}/${NUM_ROOMS}: Code ${roomData.roomId} - ${CLIENTS_PER_ROOM} clients active]\n`);
    }

    const elapsed = Date.now() - startTime;
    console.log(`\n✓ Successfully connected & synchronized ${allSockets.length} concurrent clients across ${NUM_ROOMS} rooms in ${elapsed}ms.`);

    const memRes = await fetch(`${SERVER_URL}/api/health`);
    const memData = await memRes.json();
    console.log(`✓ Server health & stats: ${JSON.stringify(memData)}`);
    console.log('--- Concurrency Test Completed Successfully ---\n');
  } finally {
    allSockets.forEach((s) => s.close());
  }
}

runLoadSimulation().catch((err) => {
  console.error('Load test failed:', err);
  process.exit(1);
});
