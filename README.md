# Yjs Collaborative Text Editor

This workspace contains the Yjs 14 core checkout at [`yjs/`](./yjs/), the
upstream WebSocket provider sources under [`providers/`](./providers/), a React
browser text editor, and an Express + WebSocket server backed by MongoDB. The
editor shares document title and plain text between clients in the same room.

This is a local learning and development setup, not a production-ready service.
The server has no authentication or room authorization.

## First-time source checkout

The `yjs/`, `providers/y-websocket/`, and
`providers/y-websocket-server/` entries in this playground point to separate
open-source repositories. GitHub may show those folder links as 404 when the
upstream source has not been cloned into your local playground checkout.
Clone the public projects into those paths before running the playground.
From the root of a fresh clone of
<https://github.com/satzh390/yjs-playground>, run these PowerShell commands:

```powershell
git clone https://github.com/yjs/yjs.git yjs
git -C yjs checkout 0e0dc3401b9753fbffb60699f6b68460cf1bcdf9

New-Item -ItemType Directory -Force providers | Out-Null
git clone https://github.com/yjs/y-websocket.git providers/y-websocket
git -C providers/y-websocket checkout f786ae973510505a129b31d14a166b2809d1f506

git clone https://github.com/yjs/y-websocket-server.git providers/y-websocket-server
git -C providers/y-websocket-server checkout 506ac10e69bcd202433657910cbf8c50b28c6f19
```

These commands check out the upstream revisions this playground was tested
with. After cloning them, continue with the Docker Compose setup below.

## Start the app

Requirements: Docker Desktop with Compose. From the workspace root run:

```powershell
docker compose up --build -d
```

Open <http://localhost:5173> in two tabs. Edit the document in both tabs and
watch changes and collaborator badges update. Use **Share** to copy a link to
the current room. The header displays the editable document name and room
name; use the room field and **Join room** to switch to another document.
Opening the same room name in another tab joins the same shared document.

Open the Yjs-aware database explorer at <http://localhost:5173/database>.
Select a room to read its reconstructed document title and text, then inspect
the stored update sequence, BSON binary subtype, byte size, and hex/base64
preview. Expand an update to load its full hex and base64 payload. The raw
update is a Yjs CRDT encoding, not JSON; the explorer replays updates through
Yjs to show readable content.

For a general-purpose MongoDB browser, open DbGate at <http://localhost:8082>.
It connects to the `yjs` database and lets you browse collections and BSON
documents. The `updates.update` field is intentionally stored as BSON Binary,
so any generic MongoDB client will show those individual update bytes as
binary; use the Yjs explorer above to read the document by replaying updates.
DbGate's saved application settings are kept separately in the `dbgate_data`
volume.

The default room's document and all other room updates are persisted in
MongoDB. The `mongo_data` volume survives container restarts and `docker compose
down`. To remove persisted documents deliberately, run:

```powershell
docker compose down --volumes
```

To see the service logs:

```powershell
docker compose logs -f mongodb websocket demo
```

## End-to-end test

Run the E2E flow against the Compose MongoDB service:

```powershell
npm run test:e2e:docker
```

The test launches an isolated WebSocket server and two real Yjs clients. It
verifies text and title sync in both directions, checks that MongoDB received
the updates, restarts the server, and confirms that the document is restored.
It removes only the uniquely named test room's MongoDB records when finished.

For a local Node.js test run outside Docker, start MongoDB and set
`MONGO_URL` to its connection string, then run `npm run test:e2e`.

## Run the core and editor without Compose

Install workspace dependencies once:

```powershell
npm ci
```

In one PowerShell window, start MongoDB (Docker may be used for just this
service):

```powershell
docker compose up -d mongodb
```

In another window, start the server:

```powershell
$env:HOST = '127.0.0.1'
$env:PORT = '1234'
$env:MONGO_URL = 'mongodb://127.0.0.1:27017/yjs'
npm run server
```

In a third window, from the workspace root:

```powershell
npm run demo
```

Open <http://localhost:5173>.

## How a keystroke flows

The editor code is in [`demo/src/main.jsx`](./demo/src/main.jsx):

1. Each browser creates a Yjs `Doc` and gets the same named roots:
   `document-title` and `document-content`.
2. When the user types, the editor finds the changed text range and applies an
   insert/delete delta to the shared content node. Yjs assigns IDs and
   deterministically integrates concurrent edits.
3. The WebSocket provider sends Yjs updates to the Express-hosted WebSocket
   server. The server applies the update to its room document and broadcasts
   it to the other peers.
4. The other browser observes its shared node and updates the editor without
   replacing the whole local document. The provider's awareness channel shares
   who is present in the room.
5. The server writes each binary Yjs update to MongoDB. On a new room
   connection, the server loads its updates in sequence before sending initial
   synchronization, so peers receive the restored document.

MongoDB stores opaque CRDT update records; it is not responsible for merging
text. That behavior remains in the Yjs core.

## Useful commands

| Goal | Command |
| --- | --- |
| Start editor, Yjs database explorer, DbGate, WebSocket server, and MongoDB | `docker compose up --build -d` |
| Stop containers and keep MongoDB data | `docker compose down` |
| Run editor/MongoDB E2E test | `npm run test:e2e:docker` |
| Run the E2E test against local MongoDB | `npm run test:e2e` |
| Run Yjs core tests | `npm run test:core` |
| Run Yjs core lint/type checks | `npm run lint:core` |
| Build browser editor | `npm run demo:build` |
| Follow logs | `docker compose logs -f mongodb websocket demo dbgate` |
| Delete all Compose volumes and their data | `docker compose down --volumes` |

## Source and compatibility notes

- The React app uses Vite; Vite deduplicates linked Yjs packages to prevent
  multiple Yjs runtimes in the browser. Provider BroadcastChannel sync is
  disabled so all clients exchange document updates through the WebSocket
  server.
- The Express server exposes `/health` and hosts the WebSocket upgrade endpoint
  on the same port (`1234`). It also serves read-only `/api/rooms` endpoints
  used by the database explorer.

- The Yjs core is the existing [`yjs/`](./yjs/) checkout
  (`@y/y` 14.0.0-rc.29).
- [`providers/y-websocket/`](./providers/y-websocket/) is cloned from
  <https://github.com/yjs/y-websocket> at commit
  `f786ae973510505a129b31d14a166b2809d1f506`.
- [`providers/y-websocket-server/`](./providers/y-websocket-server/) is cloned
  from <https://github.com/yjs/y-websocket-server> at commit
  `506ac10e69bcd202433657910cbf8c50b28c6f19`. Its server import uses the local
  Yjs 14 core, and initial sync waits for MongoDB hydration.
- The editor is intentionally plain text, not a Google Docs rich-text editor.
  Formatting, cursor positions, authentication, and authorization are not
  included.
