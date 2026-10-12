import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { app, globalEventBus } from '../src/index.js';
import { validateHeapSnapshot } from '../scripts/validate-snapshots.js';

let testServer;
let testPort;
let baseUrl;

function requestGet(path) {
  return new Promise((resolve, reject) => {
    const req = http.get(`${baseUrl}${path}`, (res) => {
      let data = '';
      res.on('data', (chunk) => {
        data += chunk;
      });
      res.on('end', () => {
        resolve({
          statusCode: res.statusCode,
          headers: res.headers,
          body: data,
        });
      });
    });
    req.on('error', reject);
    req.setTimeout(5000, () => req.destroy(new Error('Request timeout')));
  });
}

function requestPost(path, body = {}) {
  return new Promise((resolve, reject) => {
    const postData = JSON.stringify(body);
    const req = http.request(`${baseUrl}${path}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(postData),
      },
    }, (res) => {
      let data = '';
      res.on('data', (chunk) => {
        data += chunk;
      });
      res.on('end', () => {
        resolve({
          statusCode: res.statusCode,
          headers: res.headers,
          body: data,
        });
      });
    });
    req.on('error', reject);
    req.write(postData);
    req.setTimeout(5000, () => req.destroy(new Error('Request timeout')));
    req.end();
  });
}

function connectSseClient(clientId = 'test-client') {
  return new Promise((resolve, reject) => {
    const req = http.request(`${baseUrl}/api/events/subscribe?clientId=${clientId}`, {
      method: 'GET',
      headers: {
        'Accept': 'text/event-stream',
        'Cache-Control': 'no-cache',
      },
    }, (res) => {
      resolve({ req, res });
    });
    req.on('error', (err) => {
      if (err.code !== 'ECONNRESET') {
        reject(err);
      }
    });
    req.setTimeout(5000, () => req.destroy(new Error('Client timeout')));
    req.end();
  });
}

async function waitForListenerCount(target, timeoutMs = 1500) {
  const start = Date.now();
  while (globalEventBus.listenerCount('broadcast') !== target) {
    if (Date.now() - start > timeoutMs) {
      throw new Error(`Timed out waiting for listener count to become ${target}; currently ${globalEventBus.listenerCount('broadcast')}`);
    }
    await new Promise((r) => setTimeout(r, 10));
  }
}

describe('Express SSE & Memory Verification Suite', () => {
  before(async () => {
    await new Promise((resolve) => {
      testServer = app.listen(0, '127.0.0.1', () => {
        testPort = testServer.address().port;
        baseUrl = `http://127.0.0.1:${testPort}`;
        resolve();
      });
    });
  });

  after(async () => {
    if (testServer) {
      await new Promise((resolve) => testServer.close(resolve));
    }
  });

  beforeEach(async () => {
    // Wait for any trailing connections to clear before each test
    await waitForListenerCount(0, 1000).catch(() => {});
  });

  describe('Metrics Endpoint (/_debug/metrics)', () => {
    it('returns HTTP 200 with exact top-level properties', async () => {
      const res = await requestGet('/_debug/metrics');
      assert.equal(res.statusCode, 200);

      const parsed = JSON.parse(res.body);
      const keys = Object.keys(parsed).sort();
      assert.deepEqual(keys, ['listenerCount', 'memoryUsage']);
      assert.equal(typeof parsed.listenerCount, 'number');

      const memKeys = Object.keys(parsed.memoryUsage).sort();
      assert.deepEqual(memKeys, ['external', 'heapTotal', 'heapUsed', 'rss']);
      assert.equal(typeof parsed.memoryUsage.rss, 'number');
      assert.equal(typeof parsed.memoryUsage.heapTotal, 'number');
      assert.equal(typeof parsed.memoryUsage.heapUsed, 'number');
      assert.equal(typeof parsed.memoryUsage.external, 'number');
    });
  });

  describe('SSE Endpoint (/api/events/subscribe)', () => {
    it('sets correct SSE response headers', async () => {
      const { req, res } = await connectSseClient('header-test');
      try {
        assert.equal(res.statusCode, 200);
        assert.equal(res.headers['content-type'], 'text/event-stream');
        assert.equal(res.headers['cache-control'], 'no-cache');
        assert.equal(res.headers['connection'], 'keep-alive');
      } finally {
        req.destroy();
        await waitForListenerCount(0);
      }
    });

    it('increases listener count when a client connects and returns to baseline when disconnected', async () => {
      const baseline = globalEventBus.listenerCount('broadcast');
      const { req } = await connectSseClient('single-client');

      await waitForListenerCount(baseline + 1);
      assert.equal(globalEventBus.listenerCount('broadcast'), baseline + 1);

      // Abort connection
      req.destroy();

      await waitForListenerCount(baseline);
      assert.equal(globalEventBus.listenerCount('broadcast'), baseline);
    });

    it('handles multiple concurrent clients and cleans them up independently', async () => {
      const baseline = globalEventBus.listenerCount('broadcast');
      const clientCount = 10;
      const clients = [];

      for (let i = 0; i < clientCount; i++) {
        clients.push(await connectSseClient(`multi-client-${i}`));
      }

      await waitForListenerCount(baseline + clientCount);
      assert.equal(globalEventBus.listenerCount('broadcast'), baseline + clientCount);

      // Disconnect half of the clients
      for (let i = 0; i < 5; i++) {
        clients[i].req.destroy();
      }
      await waitForListenerCount(baseline + 5);
      assert.equal(globalEventBus.listenerCount('broadcast'), baseline + 5);

      // Disconnect remaining clients
      for (let i = 5; i < clientCount; i++) {
        clients[i].req.destroy();
      }
      await waitForListenerCount(baseline);
      assert.equal(globalEventBus.listenerCount('broadcast'), baseline);
    });

    it('does not accumulate listeners over repeated connect/disconnect cycles', async () => {
      const baseline = globalEventBus.listenerCount('broadcast');
      const cycles = 50;

      for (let i = 0; i < cycles; i++) {
        const { req } = await connectSseClient(`cycle-client-${i}`);
        req.destroy();
      }

      await waitForListenerCount(baseline);
      assert.equal(globalEventBus.listenerCount('broadcast'), baseline);
    });
  });

  describe('Heap Snapshot Endpoint (/_debug/snapshot)', () => {
    it('returns filename and creates a valid snapshot containing required V8 root keys', async () => {
      const testSnapshotName = `test-verify-${Date.now()}`;
      const res = await requestPost(`/_debug/snapshot?name=${testSnapshotName}`);

      assert.equal(res.statusCode, 200);
      const parsed = JSON.parse(res.body);
      assert.equal(parsed.status, 'ok');
      assert.ok(parsed.file);
      assert.ok(parsed.file.endsWith('.heapsnapshot'));

      const filePath = path.resolve('snapshots', parsed.file);
      assert.ok(fs.existsSync(filePath), 'Snapshot file must exist on disk');

      const validation = validateHeapSnapshot(filePath);
      assert.equal(validation.isValid, true);
      assert.equal(validation.hasSnapshotKey, true);
      assert.equal(validation.hasNodesKey, true);
      assert.equal(validation.hasEdgesKey, true);
      assert.equal(validation.hasStringsKey, true);

      // Clean up test verification snapshot
      fs.unlinkSync(filePath);
    });
  });
});
