# Node.js Memory Leak Resolution: Express SSE & V8 Heap Snapshots

A production-grade demonstration and resolution of a Node.js memory leak caused by uncleaned event listeners retaining HTTP response objects on Server-Sent Events (SSE) connections.

This project includes:
- Express.js SSE API with real-time broadcast capabilities.
- Programmatic memory and listener monitoring via `/_debug/metrics`.
- On-demand V8 heap snapshot generation via `/_debug/snapshot` with automatic garbage collection.
- Real V8 heap snapshots demonstrating the leak (`snapshots/before.heapsnapshot`) and proving the resolution (`snapshots/after.heapsnapshot`).
- Bounded concurrency load testing harness (`scripts/load-test.js`) capable of opening and aborting thousands of connections.
- Automated test suite using Node.js's native test runner (`tests/verification.test.js`).
- Complete Docker and Docker Compose containerization with health checks.
- Comprehensive technical report (`report.md`) detailing root cause, shallow vs. retained sizes, and Chrome DevTools profiling.

---

## 1. Prerequisites

- **Node.js**: Version 22.x or later (tested on v26 / v22)
- **npm**: Version 10.x or later
- **Docker & Docker Compose**: Optional for containerized deployment
- **Google Chrome**: For visual heap snapshot inspection via `chrome://inspect`

---

## 2. Installation and Local Startup

### Clone and Install Dependencies
```bash
npm install
```

### Start the Application
The application must be run with `--expose-gc` so the snapshot endpoint can trigger garbage collection:
```bash
npm start
```
The server will start listening on `http://0.0.0.0:3000` (or the port defined by `PORT`).

---

## 3. Docker and Docker Compose

### Build and Start with Docker Compose
```bash
docker compose up --build -d
```

### Check Container Status and Health
```bash
docker compose ps
```
The container is configured with a healthcheck against `/_debug/metrics` and becomes healthy within 5–10 seconds.

### View Logs
```bash
docker compose logs -f app
```

### Stop Containers
```bash
docker compose down
```

---

## 4. API Endpoints

### 1. `GET /api/events/subscribe`
Server-Sent Events endpoint.
- **Headers Returned**:
  - `Content-Type: text/event-stream`
  - `Cache-Control: no-cache`
  - `Connection: keep-alive`
- **Query Parameters**:
  - `clientId` *(optional)*: Unique identifier for the client connection.
- **Behavior**: Streams real-time messages emitted across `globalEventBus`. Automatically cleans up listeners when the client connection terminates.

### 2. `GET //_debug/metrics`
Reports real-time listener counts and V8 memory usage.
- **Response Format**:
```json
{
  "listenerCount": 0,
  "memoryUsage": {
    "rss": 66097152,
    "heapTotal": 13766656,
    "heapUsed": 9573976,
    "external": 2772383
  }
}
```

### 3. `POST /_debug/snapshot`
Forces garbage collection via `global.gc()` and writes a genuine V8 heap snapshot to the `snapshots/` directory.
- **Query / Body Parameters**:
  - `name` *(optional)*: Target snapshot name (e.g. `?name=after`).
- **Response Format**:
```json
{
  "status": "ok",
  "file": "after.heapsnapshot"
}
```

### 4. `POST /_debug/broadcast`
Broadcasts an event payload to all currently connected SSE clients.
- **Request Body**: JSON object payload to broadcast.
- **Response Format**:
```json
{
  "status": "ok",
  "listenerCount": 0
}
```

---

## 5. Automated Testing

Run the automated verification test suite using the built-in Node.js test runner:
```bash
npm test
```

### Test Coverage
- `/_debug/metrics` schema and value types.
- SSE response headers (`text/event-stream`, `no-cache`, `keep-alive`).
- Listener count increment on client connect and decrement on disconnect.
- Multiple concurrent clients cleaning up independently.
- Repeated connect/disconnect cycles without accumulating listeners.
- Snapshot generation and V8 root key validation (`snapshot`, `nodes`, `edges`, `strings`).

---

## 6. Load-Testing Harness

The load test script (`scripts/load-test.js`) opens and immediately aborts connections in bounded batches:
```bash
npm run test:load
```

### Configuration via Environment Variables
- `BASE_URL`: Server endpoint (default: `http://localhost:3000`).
- `TOTAL_REQUESTS`: Total connections to open and abort (default: `5000`).
- `CONCURRENCY`: Bounded simultaneous active requests (default: `50`).
- `REQUEST_TIMEOUT_MS`: Timeout per request (default: `10000`).

Example running with custom parameters:
```bash
TOTAL_REQUESTS=1000 CONCURRENCY=25 npm run test:load
```

---

## 7. Memory Leak Reproduction and Fix Workflow

### Step 1: The Bug (Reproduction)
In the buggy version, an anonymous callback is registered on `globalEventBus`:
```javascript
globalEventBus.on('broadcast', (data) => {
  res.write(`data: ${JSON.stringify(data)}\n\n`);
});
```
Because the listener is anonymous and no `res.on('close')` cleanup hook is registered, the callback retains the `res` (`ServerResponse`) object in memory permanently.

1. Start server with buggy code.
2. Run load test: `npm run test:load` (5,000 aborted connections).
3. Query `/_debug/metrics`: Listener count increases to 5,000.
4. Capture `snapshots/before.heapsnapshot`: Retains 5,006 `ServerResponse` objects; heap remains inflated by +30.08 MiB after GC.

### Step 2: The Fix
The handler is converted to a named callback and removed when `res` closes:
```javascript
const handler = (data) => {
  try {
    res.write(`data: ${JSON.stringify(data)}\n\n`);
  } catch {}
};
globalEventBus.on('broadcast', handler);

let isCleanedUp = false;
const cleanup = () => {
  if (isCleanedUp) return;
  isCleanedUp = true;
  globalEventBus.removeListener('broadcast', handler);
};
res.on('close', cleanup);
```

1. Start the patched server.
2. Run load test: `npm run test:load` (5,000 aborted connections).
3. Query `/_debug/metrics`: Listener count returns to 0.
4. Capture `snapshots/after.heapsnapshot`: Heap usage returns within 0.87 MiB of baseline after GC.

---

## 8. Comparing Heap Snapshots in Chrome DevTools

1. Open Google Chrome and navigate to `chrome://inspect`.
2. Click **Open dedicated DevTools for Node**.
3. Select the **Memory** tab.
4. Click **Load** and load both:
   - `snapshots/before.heapsnapshot`
   - `snapshots/after.heapsnapshot`
5. Select `before.heapsnapshot` and filter by `ServerResponse`:
   - Inspect the 5,006 instances and their retainers pointing to `globalEventBus`.
6. Select `after.heapsnapshot` and switch the perspective to **Comparison** (with `before.heapsnapshot` as baseline):
   - Verify `# Delta: -5,000` for `ServerResponse`, `IncomingMessage`, and `Socket`.

You can also run the automated snapshot validator:
```bash
node scripts/validate-snapshots.js
```

---

## 9. Creating the Submission Archive

To generate `submission.zip` containing all project files:
```powershell
# In PowerShell (Windows):
Compress-Archive -Path package.json, package-lock.json, Dockerfile, docker-compose.yml, .env.example, .gitignore, README.md, report.md, src, scripts, tests, snapshots -DestinationPath submission.zip -Force
```
or via standard `zip` on Linux/macOS:
```bash
zip -r submission.zip package.json package-lock.json Dockerfile docker-compose.yml .env.example .gitignore README.md report.md src/ scripts/ tests/ snapshots/
```
