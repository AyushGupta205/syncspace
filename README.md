# SyncSpace Watch Party

SyncSpace is a high-performance, real-time YouTube watch party application built with modern React, Node.js, Express, and Socket.IO. Users can create synchronized rooms with unique six-character codes, invite friends via direct shareable links, and stream YouTube videos in tight synchronization with role-based access control, live chat, interactive emoji reactions, and persistent state recovery.

---

## Table of Contents
- [Features](#features)
- [Technology Stack](#technology-stack)
- [System Architecture & OOP Design](#system-architecture--oop-design)
- [Role-Based Access Control (RBAC)](#role-based-access-control-rbac)
- [Real-Time Synchronization Strategy](#real-time-synchronization-strategy)
- [WebSocket Events Reference](#websocket-events-reference)
- [Persistence & SQLite Architecture](#persistence--sqlite-architecture)
- [Scalability & Redis Multi-Instance Roadmap](#scalability--redis-multi-instance-roadmap)
- [Security, Rate Limiting & Error Handling](#security-rate-limiting--error-handling)
- [Local Setup & Development](#local-setup--development)
- [Automated Testing & Concurrency Benchmarks](#automated-testing--concurrency-benchmarks)
- [Production Deployment (Render / Railway)](#production-deployment-render--railway)
- [Known Limitations](#known-limitations)

---

## Features

- **Room Management**: Instant 6-character room code generation (e.g. `M3RRBS`) with collision avoidance and deep linking via `?room=CODE`.
- **Authoritative YouTube Player**: Embedded via the official YouTube IFrame Player API (16:9 responsive aspect ratio), preserving native fullscreen, captions, and video quality controls.
- **Microsecond Synchronization**: Server-authoritative playback timeline with drift correction, eliminating infinite loops and client echo.
- **Custom Playback Toolbar**: Quick `−10s` rewind, `+10s` fast-forward, and expandable `Change Video` panel supporting standard URLs, Shorts, embeds, and raw 11-char IDs.
- **Role-Based Access Control (RBAC)**:
  - **Host**: Creator of the room; possesses full room control, video changing, role promotion/demotion, participant removal, and Host ownership transfer.
  - **Moderator**: Authorized by the Host to control playback and change videos.
  - **Participant**: Watch-only viewer with interactive chat and reaction capabilities.
- **Live Room Chat**: Real-time group messaging with auto-scroll, formatted timestamps, rate limiting, and system lifecycle announcements (join, leave, promotion, removal).
- **Synchronized Floating Reactions**: Live emoji reaction bar (`🔥`, `❤️`, `😂`, `👏`, `🎉`, `😮`) rendering floating animated reactions across peer players.
- **Persistent Room State**: SQLite engine automatically preserves room metadata, video timelines, and member roles across server restarts.
- **Seamless Session Recovery**: 15-minute reconnect grace period using cryptographic private session tokens, shielding against transient network drops.

---

## Technology Stack

- **Frontend**: React 19, Vite 7, Vanilla CSS3 (Custom Design System with Dark/Light theme toggle).
- **Backend**: Node.js 20+ (Node 25 tested), Express 5, Socket.IO 4.
- **Storage / Persistence**: Embedded SQLite via Node's native `node:sqlite` (`DatabaseSync`), falling back to high-speed in-memory maps.
- **Testing**: Node.js Native Test Runner (`node:test`, `node:assert/strict`), Socket.IO client multi-session integration suite.

---

## System Architecture & OOP Design

SyncSpace separates responsibilities cleanly across specialized Object-Oriented classes on the server:

```text
┌─────────────────────────────────────────────────────────────┐
│                       Express 5 Server                      │
│      - HTTP Security Headers (nosniff, referrer, CSP)       │
│      - Health Check Endpoint (/api/health)                  │
│      - Static Client Delivery (dist/index.html)             │
└──────────────────────────────┬──────────────────────────────┘
                               │
                ┌──────────────┴──────────────┐
                ▼                             ▼
   ┌───────────────────────────┐ ┌───────────────────────────┐
   │     DatabaseService       │ │      Socket.IO Engine     │
   │  - SQLite (node:sqlite)   │ │  - WebSocket & Polling    │
   │  - Schema Initialization  │ │  - Ping / Pong Heartbeat  │
   │  - Persistent CRUD Ops    │ └─────────────┬─────────────┘
   └────────────▲──────────────┘               │
                │                              ▼
   ┌────────────┴──────────────┐ ┌───────────────────────────┐
   │        RoomManager        │ │    SocketEventHandler     │
   │  - Room Creation & Lookup │ │  - Event Registration     │
   │  - Code Generation        │ │  - RBAC Authorization     │
   │  - Inactivity Pruning     │ │  - Payload Normalization  │
   │  - DB State Restoration   │ └─────────────┬─────────────┘
   └────────────▲──────────────┘               │
                │                              │
         ┌──────┴──────┐                       ▼
         ▼             ▼         ┌───────────────────────────┐
   ┌───────────┐ ┌───────────┐   │      MessageHandler       │
   │   Room    │ │Participant│   │  - Chat Validation & XSS  │
   │ - Timeline│ │ - Identity│   │  - Rate Limit Checking    │
   │ - State   │ │ - Role    │   │  - Emoji Reactions Format │
   │ - Roster  │ │ - Session │   └───────────────────────────┘
   └───────────┘ └───────────┘
```

1. **`Participant` (`server/Participant.js`)**: Encapsulates participant identity, display name, role (`host`, `moderator`, `participant`), socket binding, session token, and connection status.
2. **`Room` (`server/Room.js`)**: Manages the authoritative video state (`videoId`, `currentTime`, `isPlaying`, `playState`, `updatedAt`), participant rosters, and role modifications.
3. **`RoomManager` (`server/RoomManager.js`)**: Handles room lifecycle, collision-free code generation, inactive room garbage collection, creation rate limiting, and persistence restoration.
4. **`MessageHandler` (`server/MessageHandler.js`)**: Handles message sanitization, length validation, emoji normalization, and chat frequency throttling.
5. **`SocketEventHandler` (`server/SocketEventHandler.js`)**: Registers and routes WebSocket events, enforces server-side RBAC guards, and handles payload delivery.
6. **`DatabaseService` (`server/db.js`)**: Provides persistent storage for room metadata and participant rosters using native SQLite.

---

## Role-Based Access Control (RBAC)

All permission checks are executed server-side. Unpermitted actions are rejected with an explicit `action_rejected` socket emission:

| Feature / Action | Host | Moderator | Participant |
| :--- | :---: | :---: | :---: |
| Play / Pause Video | ✅ | ✅ | ❌ *(Rejected)* |
| Seek Timestamp | ✅ | ✅ | ❌ *(Rejected)* |
| Change Video URL / ID | ✅ | ✅ | ❌ *(Rejected)* |
| Promote to Moderator | ✅ | ❌ | ❌ |
| Demote to Participant | ✅ | ❌ | ❌ |
| Transfer Host Ownership | ✅ | ❌ | ❌ |
| Remove (Kick) Participant| ✅ | ❌ | ❌ |
| Send Chat Messages | ✅ | ✅ | ✅ |
| Send Emoji Reactions | ✅ | ✅ | ✅ |

---

## Real-Time Synchronization Strategy

1. **Authoritative Timeline**: The server maintains the source of truth. When a playback mutation occurs (`play`, `pause`, `seek`, `change_video`), the server updates the room state and broadcasts `sync_state` to all room sockets.
2. **Loop & Echo Prevention**: When the client receives `sync_state`, `YouTubePlayer` sets `isApplying.current = true` before commanding the YouTube iframe API (`playVideo()`, `pauseVideo()`, `seekTo()`). This prevents local iframe player event listeners from echoing mutations back to the server.
3. **Drift Correction**: If a client's playback timestamp drifts by more than 1.0 second from the authoritative timeline, a soft seek `instance.seekTo(targetTime, true)` aligns playback. Micro-fluctuations under 1.0 second are ignored to prevent audio micro-stutters.
4. **Participant Local Snapback**: If a viewer clicks the native player inside the iframe directly, the client-side listener checks their role. Non-moderator attempts are rejected and immediately overridden by snapping back to authoritative server state.

---

## WebSocket Events Reference

| Event Name | Direction | Payload | Description |
| :--- | :--- | :--- | :--- |
| `create_room` | Client → Server | `{ username, videoId? }` | Creates room; client becomes Host. |
| `join_room` | Client → Server | `{ roomId, username }` | Joins room; client becomes Participant. |
| `resume_room` | Client → Server | `{ roomId, sessionToken }` | Resumes session after disconnect. |
| `leave_room` | Client → Server | `{ roomId }` | Gracefully leaves room. |
| `sync_state` | Server → Client | `{ playState, currentTime, videoId, isPlaying }` | Authoritative room playback broadcast. |
| `play` | Client → Server | `{ roomId, currentTime }` | Starts playback (Host/Mod only). |
| `pause` | Client → Server | `{ roomId, currentTime }` | Pauses playback (Host/Mod only). |
| `seek` | Client → Server | `{ roomId, currentTime }` | Seeks to timestamp (Host/Mod only). |
| `change_video` | Client → Server | `{ roomId, videoId }` | Changes video ID (Host/Mod only). |
| `playback` | Client → Server | `{ roomId, type, time, videoId? }` | Unified playback control route. |
| `assign_role` | Client → Server | `{ roomId, userId, role }` | Promotes/demotes member (Host only). |
| `transfer_host` | Client → Server | `{ roomId, userId }` | Transfers Host ownership (Host only). |
| `remove_participant`| Client → Server | `{ roomId, userId }` | Removes disruptive user (Host only). |
| `user_joined` | Server → Client | `{ username, userId, role, participants }` | Broadcast when user joins. |
| `user_left` | Server → Client | `{ username, userId, participants }` | Broadcast when user leaves. |
| `role_assigned` | Server → Client | `{ userId, username, role, participants }` | Broadcast on role change. |
| `participant_removed`| Server → Client | `{ userId, participants }` | Broadcast when user is removed. |
| `removed_from_room` | Server → Client | *(empty)* | Direct notification to removed user. |
| `participants_updated`| Server → Client | `[ { id, username, role, connected } ]` | Full roster broadcast. |
| `chat` | Client → Server | `{ roomId, text/message }` | Sends chat message. |
| `chat_message` | Server → Client | `{ id, username, text, time, timestamp }` | Live chat broadcast. |
| `reaction` | Bi-directional | `{ roomId, emoji, username?, id? }` | Broadcasts floating emoji reaction. |
| `chat_rate_limited` | Server → Client | `{ error }` | Warns user of message flooding. |
| `action_rejected` | Server → Client | `{ message, error }` | Explains permission/validation failure. |

---

## Persistence & SQLite Architecture

SyncSpace integrates a persistent SQLite storage layer (`server/db.js` using Node's native `DatabaseSync`):
- **Rooms Table**: Tracks `id`, `video_id`, `current_time`, `is_playing`, `created_at`, `updated_at`.
- **Participants Table**: Tracks `id`, `room_id`, `username`, `role`, `session_token`, `connected`, `disconnected_at`.
- **Automatic Recovery**: On server startup, `RoomManager.restoreFromDb()` loads all persisted rooms and participant sessions. Reconnecting users can immediately recover their seats and roles using their browser session token.
- **Zero-Dependency**: Built on Node's native SQLite engine without requiring C++ node-gyp builds or external database servers.

---

## Scalability & Redis Multi-Instance Roadmap

Tested with 50 concurrent Socket.IO clients across 5 independent rooms. Larger-scale capacity has not yet been benchmarked. When scaling horizontally across multiple cloud instances or container replicas:

```text
               ┌─────────────────────────────────────┐
               │         Load Balancer / Proxy       │
               │   (Sticky Sessions by Client IP)    │
               └───────────┬──────────────┬──────────┘
                           │              │
             ┌─────────────▼─┐          ┌─▼─────────────┐
             │ Node Instance │          │ Node Instance │
             │     (Pod 1)   │          │     (Pod 2)   │
             └───────┬───────┘          └───────┬───────┘
                     │                          │
                     └───────────┬──────────────┘
                                 ▼
                     ┌───────────────────────┐
                     │   Redis Cluster / DB  │
                     │  - @socket.io/redis-  │
                     │    adapter (Pub/Sub)  │
                     │  - Shared Room Cache  │
                     └───────────────────────┘
```

### Steps to Enable Multi-Instance Redis Adapter:
1. Install the official adapter:
   ```bash
   npm install @socket.io/redis-adapter ioredis
   ```
2. In `server/index.js`, attach the adapter:
   ```javascript
   import { createAdapter } from '@socket.io/redis-adapter';
   import Redis from 'ioredis';

   if (process.env.REDIS_URL) {
     const pubClient = new Redis(process.env.REDIS_URL);
     const subClient = pubClient.duplicate();
     io.adapter(createAdapter(pubClient, subClient));
     console.log('Socket.IO Redis adapter enabled for multi-instance clustering.');
   }
   ```
3. Configure your cloud load balancer (e.g. AWS ALB, NGINX, Cloudflare) with **Sticky Sessions** (Session Affinity via cookie or IP) to ensure WebSocket upgrade handshakes land on the same server instance.

---

## Security, Rate Limiting & Error Handling

- **XSS & Injection Protection**: Usernames and chat messages are strictly validated, sanitized, truncated, and rendered safely via React text nodes (no `dangerouslySetInnerHTML`).
- **Cryptographic Tokens**: Session tokens are generated using `node:crypto` (`randomUUID()`), stored securely in `sessionStorage`, and never broadcast to other room participants.
- **Rate Limiting**:
  - Room Creation: Max 10 rooms per minute per IP address.
  - Chat Messaging: Max 5 messages per 2-second rolling window per socket connection.
- **HTTP Security Headers**: Strict HTTP headers enforced via custom Express middleware:
  - `X-Content-Type-Options: nosniff`
  - `Referrer-Policy: strict-origin-when-cross-origin`
  - `Permissions-Policy: camera=(), microphone=(), geolocation=()`
- **Dependency Audit**: Verified clean with `npm audit` (**0 vulnerabilities found**).

---

## Local Setup & Development

### Prerequisites
- Node.js 20 or newer (tested and verified on Node.js 25.1.0).

### 1. Clone & Install Dependencies
```bash
git clone https://github.com/AyushGupta205/syncspace.git
cd syncspace
npm install
```

### 2. Start Development Environment
```bash
npm run dev
```
- Frontend starts at: `http://localhost:5173`
- Backend API & Socket server start at: `http://localhost:3005`

### 3. Build & Run Production Locally
```bash
npm run build
npm start
```
The server will build the client and serve production assets at `http://localhost:3005`.

---

## Automated Testing & Concurrency Benchmarks

### 1. Run Unit & Integration Test Suite
```bash
npm test
```
**Test Coverage Results:**
```text
✔ room creation, authorization, synchronization, isolation, removal, and reconnection (427ms)
✔ host transfer, reactions, direct play/pause/seek/change_video events, and granular room broadcasts (123ms)
✔ SQLite persistent room recovery across server restart and chat rate limiting (296ms)
tests 3 | suites 0 | pass 3 | fail 0 | cancelled 0 | skipped 0
```

### 2. Run Comprehensive Multi-Session Audit
```bash
node scratch/comprehensive_test.mjs
```
Verifies 10 real-world end-to-end socket flows including concurrent rooms, host transfer, rate limiting, and reconnect recovery.

### 3. Run Controlled Load Simulation
```bash
node scratch/load_test.mjs
```
**Benchmark Result:** Successfully connected and synchronized **50 concurrent socket clients across 5 independent rooms in 580ms** with zero dropped packets or memory spikes.

---

## Production Deployment (Render / Railway)

SyncSpace requires a persistent Node process for WebSocket connections. Deploy as a **Web Service** (not a static site).

### Deploying to Render
1. Push this repository to GitHub or GitLab.
2. In Render Dashboard, click **New +** → **Web Service** and select your repository.
3. Configure settings:
   - **Environment**: `Node`
   - **Build Command**: `npm ci && npm run build`
   - **Start Command**: `npm start`
4. Add Environment Variables:
   - `NODE_ENV`: `production`
   - `CLIENT_ORIGIN`: `https://your-app-name.onrender.com` *(or comma-separated list of allowed origins)*
   - `PORT`: `10000` *(Render sets this automatically)*
   - `DB_PATH`: `/data/syncspace.db` *(Attach a Render Persistent Disk mounted at `/data` as configured in `render.yaml` for persistent SQLite across deploys)*
5. Click **Create Web Service**. Verify health endpoint at `https://your-app-name.onrender.com/api/health`.

### Deploying to Railway
1. Click **New Project** → **Deploy from GitHub repo**.
2. Railway detects the Node environment automatically.
3. In service **Settings** → **Variables**:
   - Add `CLIENT_ORIGIN` with your Railway generated domain.
   - Attach a Railway Volume mounted to `/data` and set `DB_PATH=/data/syncspace.db`.

---

## Known Limitations

1. **Third-Party YouTube Embed Restrictions**: Certain commercial music videos and protected content owners disable embedding on external websites (YouTube error code 101/150). SyncSpace detects these error codes and displays a clear, helpful banner informing users that the owner disabled iframe embedding.
2. **Multi-Instance Redis Setup**: Single-instance deployment utilizes the native in-process room manager and embedded SQLite. Horizontally scaling across multiple server instances requires configuring Redis Pub/Sub adapter as documented in the [Scalability section](#scalability--redis-multi-instance-roadmap).
3. **Local Dev Network Port Binding**: In sandboxed virtualization environments on Windows, loopback network access requires elevated privileges or running commands unsandboxed.
