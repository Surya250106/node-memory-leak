import express from 'express';
import { EventEmitter } from 'node:events';
import v8 from 'node:v8';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const SNAPSHOTS_DIR = path.resolve(__dirname, '..', 'snapshots');

export const app = express();
export const globalEventBus = new EventEmitter();

// Allow high listener concurrency under load
globalEventBus.setMaxListeners(0);

app.use(express.json());

/**
 * GET /api/events/subscribe
 * Server-Sent Events endpoint
 * 
 * FIXED IMPLEMENTATION:
 * - Uses a named callback `handler`
 * - Registers it with `globalEventBus.on('broadcast', handler)`
 * - Registers cleanup on the HTTP response's `close` event
 * - Removes the exact callback reference using `globalEventBus.removeListener('broadcast', handler)`
 * - Cleanup is safe to execute only once (boolean guard)
 * - Correctly handles abrupt client disconnects
 * - Preserves SSE functionality
 */
app.get('/api/events/subscribe', (req, res) => {
  const clientId = req.query.clientId || `client-${Date.now()}-${Math.random().toString(36).substring(2, 7)}`;

  // Set required SSE headers
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders?.();

  // Send initial connection event
  res.write(`data: ${JSON.stringify({ type: 'connected', clientId, timestamp: Date.now() })}\n\n`);

  // Named event handler
  const handler = (data) => {
    try {
      res.write(`data: ${JSON.stringify(data)}\n\n`);
    } catch {
      // In case write is attempted while socket is tearing down
    }
  };

  // Register the named handler on the global bus
  globalEventBus.on('broadcast', handler);

  // Idempotent cleanup to prevent duplicate listener removal and retain zero references
  let isCleanedUp = false;
  const cleanup = () => {
    if (isCleanedUp) return;
    isCleanedUp = true;
    globalEventBus.removeListener('broadcast', handler);
  };

  // Handle client disconnect or socket termination
  res.on('close', cleanup);
});

/**
 * GET /_debug/metrics
 * Reports globalEventBus broadcast listener count and V8 process memory usage
 */
app.get('/_debug/metrics', (req, res) => {
  const mem = process.memoryUsage();
  res.status(200).json({
    listenerCount: globalEventBus.listenerCount('broadcast'),
    memoryUsage: {
      rss: mem.rss,
      heapTotal: mem.heapTotal,
      heapUsed: mem.heapUsed,
      external: mem.external,
    },
  });
});

/**
 * POST /_debug/snapshot
 * Triggers V8 heap snapshot generation
 */
app.post('/_debug/snapshot', (req, res) => {
  try {
    // Force garbage collection before snapshot if exposed
    if (typeof global.gc === 'function') {
      global.gc();
    }

    if (!fs.existsSync(SNAPSHOTS_DIR)) {
      fs.mkdirSync(SNAPSHOTS_DIR, { recursive: true });
    }

    let requestedName = req.query.name || req.body?.name || `snapshot-${Date.now()}`;
    if (!requestedName.endsWith('.heapsnapshot')) {
      requestedName = `${requestedName}.heapsnapshot`;
    }
    const safeName = path.basename(requestedName);
    const targetPath = path.join(SNAPSHOTS_DIR, safeName);

    const actualPath = v8.writeHeapSnapshot(targetPath);
    const fileName = path.basename(actualPath || targetPath);

    return res.status(200).json({
      status: 'ok',
      file: fileName,
    });
  } catch (err) {
    return res.status(500).json({
      status: 'error',
      message: err.message,
    });
  }
});

/**
 * POST /_debug/broadcast
 * Emits broadcast event for test and live verification
 */
app.post('/_debug/broadcast', (req, res) => {
  const payload = req.body || { message: 'broadcast', timestamp: Date.now() };
  globalEventBus.emit('broadcast', payload);
  res.status(200).json({
    status: 'ok',
    listenerCount: globalEventBus.listenerCount('broadcast'),
  });
});

const PORT = parseInt(process.env.PORT || '3000', 10);
const HOST = '0.0.0.0';

export let server = null;
const isDirectRun = !process.argv[1] || process.argv[1].endsWith('index.js');

if (process.env.NODE_ENV !== 'test' || isDirectRun) {
  if (isDirectRun) {
    server = app.listen(PORT, HOST, () => {
      console.log(`[Express SSE Server] Listening on http://${HOST}:${PORT}`);
    });
  }
}
