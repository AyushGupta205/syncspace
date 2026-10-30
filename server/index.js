import express from 'express';
import cors from 'cors';
import { createServer } from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Server } from 'socket.io';
import { DatabaseService } from './db.js';
import { RoomManager } from './RoomManager.js';
import { MessageHandler } from './MessageHandler.js';
import { SocketEventHandler } from './SocketEventHandler.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const allowedOrigins = (value) => {
  if (value && value.trim() !== '*') {
    const list = value.split(',').map((item) => item.trim()).filter(Boolean);
    if (list.length > 0) return list;
  }
  return true;
};

export function createPartyServer({
  clientOrigin = process.env.CLIENT_ORIGIN,
  serveClient = true,
  dbPath = process.env.DB_PATH || (process.env.NODE_ENV === 'test' ? ':memory:' : 'data/syncspace.db'),
} = {}) {
  const app = express();
  const httpServer = createServer(app);
  const origin = allowedOrigins(clientOrigin);
  const io = new Server(httpServer, {
    cors: { origin, methods: ['GET', 'POST'] },
    // WebSocket upgrade settings for production proxies and low latency
    pingInterval: 10000,
    pingTimeout: 5000,
  });

  const db = new DatabaseService({ dbPath });
  const roomManager = new RoomManager({ db });
  const messageHandler = new MessageHandler();
  const socketHandler = new SocketEventHandler({ io, roomManager, messageHandler });

  const pruneTimer = setInterval(() => {
    roomManager.prune(io);
  }, 60_000);
  pruneTimer.unref();

  app.disable('x-powered-by');
  app.use((_, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
    res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
    next();
  });
  app.use(cors({ origin }));
  app.use(express.json());

  app.get('/api/health', (_, res) =>
    res.json({
      ok: true,
      service: 'syncspace-watch-party',
      rooms: roomManager.rooms.size,
      uptime: Math.floor(process.uptime()),
      timestamp: Date.now(),
    })
  );

  if (serveClient) {
    app.use(express.static(path.join(__dirname, '../dist')));
    app.get(/.*/, (_, res) => res.sendFile(path.join(__dirname, '../dist/index.html')));
  }

  io.on('connection', (socket) => {
    socketHandler.register(socket);
  });

  const close = async () => {
    clearInterval(pruneTimer);
    io.close();
    db.close();
    await new Promise((resolve) => httpServer.close(resolve));
  };

  return {
    app,
    httpServer,
    io,
    rooms: roomManager.rooms,
    roomManager,
    db,
    messageHandler,
    socketHandler,
    pruneTimer,
    close,
  };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { httpServer, close } = createPartyServer();
  const port = process.env.PORT || 3005;
  const server = httpServer.listen(port, () =>
    console.log(`SyncSpace server listening on ${port} (PID: ${process.pid})`)
  );

  const shutdown = async (signal) => {
    console.log(`\nReceived ${signal}. Gracefully shutting down SyncSpace server...`);
    await close();
    process.exit(0);
  };

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}
