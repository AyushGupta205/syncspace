import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';
import { io } from 'socket.io-client';
import { createPartyServer } from '../server/index.js';

async function verifyProductionStartup() {
  console.log('--- Verifying Production Server Startup & Client Delivery ---');

  const testDb = path.join(process.cwd(), 'data', `prod-test-${Date.now()}.db`);
  process.env.NODE_ENV = 'production';

  const { httpServer, close } = createPartyServer({
    serveClient: true,
    dbPath: testDb,
  });

  await new Promise((resolve) => httpServer.listen(0, resolve));
  const port = httpServer.address().port;
  const baseUrl = `http://127.0.0.1:${port}`;
  console.log(`✓ Production server started listening on ${baseUrl}`);

  try {
    // 1. Verify health check
    const healthRes = await fetch(`${baseUrl}/api/health`);
    assert.equal(healthRes.status, 200);
    const healthJson = await healthRes.json();
    assert.equal(healthJson.ok, true);
    assert.equal(healthJson.service, 'syncspace-watch-party');
    console.log('✓ /api/health returned 200 OK with expected JSON:', healthJson);

    // 2. Verify static client delivery
    const clientRes = await fetch(`${baseUrl}/`);
    assert.equal(clientRes.status, 200);
    const clientHtml = await clientRes.text();
    assert(clientHtml.includes('<div id="root">'), 'Served index.html must contain root element');
    assert(clientHtml.includes('/assets/index-'), 'Served index.html must reference built assets');
    console.log('✓ Express successfully serves the Vite production build from dist/index.html');

    // 3. Verify client route fallback
    const routeRes = await fetch(`${baseUrl}/room/ABC123`);
    assert.equal(routeRes.status, 200);
    const routeHtml = await routeRes.text();
    assert(routeHtml.includes('<div id="root">'), 'SPA deep-links must return index.html');
    console.log('✓ SPA deep-link fallback route verified');

    // 4. Verify Socket.IO production WebSocket connection
    const clientSocket = io(baseUrl, {
      transports: ['websocket'],
      forceNew: true,
      reconnection: false,
    });
    await new Promise((resolve) => clientSocket.on('connect', resolve));
    console.log('✓ Production WebSocket connection established');

    const created = await new Promise((resolve) => {
      clientSocket.emit('create_room', { username: 'ProdUser', videoId: 'dQw4w9WgXcQ' }, resolve);
    });
    assert(created.roomId);
    assert.equal(created.self.role, 'host');
    console.log(`✓ Production room created successfully: ${created.roomId}`);

    clientSocket.disconnect();
    console.log('--- Production Verification Completed Successfully ---');
  } finally {
    await close();
    try { fs.unlinkSync(testDb); } catch {}
  }
}

verifyProductionStartup().catch((err) => {
  console.error('Production verification failed:', err);
  process.exit(1);
});
