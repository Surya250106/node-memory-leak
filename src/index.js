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

// Allow thousands of listeners for stress testing without Node maxListener warnings
globalEventBus.setMaxListeners(0);

app.use(express.json());

/**
 * GET /api/events/subscribe
 * Server-Sent Events endpoint
 * 
 * BUGGY IMPLEMENTATION:
 * The listener attached to globalEventBus closes over `res`, but is NEVER removed
 * when the client disconnects or the response closes.
 * This retains the HTTP response object, underlying socket, and buffers indefinitely.
 */
app.get('/api/events/subscribe', (req, res) => {
  const clientId = req.query.clientId || `client-${Date.now()}-${Math.random().toString(36).substring(2, 7)}`;

  // Required SSE headers
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders?.();

  // Send initial connection event
  res.write(`data: ${JSON.stringify({ type: 'connected', clientId, timestamp: Date.now() })}\n\n`);

  // LEAK: Anonymous listener closes over `res` and is never cleaned up on close
  globalEventBus.on('broadcast', (data) => {
    try {
      res.write(`data: ${JSON.stringify(data)}\n\n`);
    } catch {
      // In leaky state, res might be closed or errored, yet listener remains attached
    }
  });

  // Notice: No cleanup on res.on('close', ...) here!
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
    // Force garbage collection if V8 expose-gc flag is active
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
 * Helper endpoint to emit a broadcast event for testing SSE distribution
 */
app.post('/_debug/broadcast', (req, res) => {
  const payload = req.body || { message: 'test', timestamp: Date.now() };
  globalEventBus.emit('broadcast', payload);
  res.status(200).json({
    status: 'ok',
    listenerCount: globalEventBus.listenerCount('broadcast'),
  });
});

const PORT = parseInt(process.env.PORT || '3000', 10);
const HOST = '0.0.0.0';

export let server = null;
if (process.env.NODE_ENV !== 'test_manual') {
  server = app.listen(PORT, HOST, () => {
    console.log(`[Express SSE Server (BUGGY)] Listening on http://${HOST}:${PORT}`);
  });
}
