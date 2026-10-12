import http from 'node:http';
import { URL } from 'node:url';

const BASE_URL = process.env.BASE_URL || 'http://localhost:3000';
const TOTAL_REQUESTS = parseInt(process.env.TOTAL_REQUESTS || '5000', 10);
const CONCURRENCY = parseInt(process.env.CONCURRENCY || '50', 10);
const REQUEST_TIMEOUT_MS = parseInt(process.env.REQUEST_TIMEOUT_MS || '10000', 10);

async function fetchMetrics(baseUrl) {
  return new Promise((resolve, reject) => {
    const url = new URL('/_debug/metrics', baseUrl);
    const req = http.get(url, (res) => {
      let data = '';
      res.on('data', (chunk) => {
        data += chunk;
      });
      res.on('end', () => {
        if (res.statusCode === 200) {
          try {
            resolve(JSON.parse(data));
          } catch (e) {
            reject(new Error(`Failed to parse metrics JSON: ${e.message}`));
          }
        } else {
          reject(new Error(`Metrics endpoint returned status ${res.statusCode}: ${data}`));
        }
      });
    });
    req.on('error', reject);
    req.setTimeout(5000, () => {
      req.destroy(new Error('Metrics request timed out'));
    });
  });
}

async function waitForServer(baseUrl, maxRetries = 10, delayMs = 500) {
  for (let i = 0; i < maxRetries; i++) {
    try {
      const metrics = await fetchMetrics(baseUrl);
      return metrics;
    } catch {
      await new Promise((r) => setTimeout(r, delayMs));
    }
  }
  throw new Error(`Server at ${baseUrl} is not reachable after ${maxRetries} attempts.`);
}

function openAndAbortConnection(baseUrl, clientId) {
  return new Promise((resolve, reject) => {
    const url = new URL('/api/events/subscribe', baseUrl);
    url.searchParams.set('clientId', clientId);

    let isSettled = false;
    let intentionalAbort = false;

    const settle = (err) => {
      if (isSettled) return;
      isSettled = true;
      clearTimeout(timer);
      if (err) {
        reject(err);
      } else {
        resolve();
      }
    };

    const timer = setTimeout(() => {
      if (!isSettled) {
        req.destroy();
        settle(new Error(`Request timed out after ${REQUEST_TIMEOUT_MS}ms`));
      }
    }, REQUEST_TIMEOUT_MS);

    const req = http.request(url, {
      method: 'GET',
      headers: {
        'Accept': 'text/event-stream',
        'Cache-Control': 'no-cache',
      },
    }, (res) => {
      if (res.statusCode !== 200) {
        req.destroy();
        settle(new Error(`Server responded with HTTP status ${res.statusCode}`));
        return;
      }

      // As soon as the SSE stream begins, consume initial chunk and abort
      res.once('data', () => {
        intentionalAbort = true;
        req.destroy();
        settle();
      });

      // Fallback in case first chunk is delayed: abort after a brief tick
      setTimeout(() => {
        if (!isSettled) {
          intentionalAbort = true;
          req.destroy();
          settle();
        }
      }, 50);
    });

    req.on('error', (err) => {
      // Intentional aborts will produce ECONNRESET, aborted, or socket hang up
      if (intentionalAbort || err.code === 'ECONNRESET' || err.message?.includes('socket hang up') || err.message?.includes('abort')) {
        settle();
      } else {
        settle(err);
      }
    });

    req.on('close', () => {
      settle();
    });

    req.end();
  });
}

async function runLoadTest() {
  console.log('='.repeat(60));
  console.log('Node.js Memory Leak Load Testing Harness');
  console.log(`Target URL:       ${BASE_URL}`);
  console.log(`Total Requests:   ${TOTAL_REQUESTS}`);
  console.log(`Concurrency:      ${CONCURRENCY}`);
  console.log(`Request Timeout:  ${REQUEST_TIMEOUT_MS}ms`);
  console.log('='.repeat(60));

  console.log('\n[1/3] Verifying server reachability...');
  let initialMetrics;
  try {
    initialMetrics = await waitForServer(BASE_URL);
    console.log('Server is reachable. Baseline metrics:');
    console.log(`  Listener count:  ${initialMetrics.listenerCount}`);
    console.log(`  Heap used:       ${(initialMetrics.memoryUsage.heapUsed / 1024 / 1024).toFixed(2)} MB`);
    console.log(`  Heap total:      ${(initialMetrics.memoryUsage.heapTotal / 1024 / 1024).toFixed(2)} MB`);
    console.log(`  RSS:             ${(initialMetrics.memoryUsage.rss / 1024 / 1024).toFixed(2)} MB`);
  } catch (err) {
    console.error(`ERROR: Failed to connect to server: ${err.message}`);
    process.exit(1);
  }

  console.log('\n[2/3] Executing load test (opening and aborting connections in bounded batches)...');
  const startTime = Date.now();
  let completed = 0;
  let nextIndex = 0;
  let unexpectedErrors = 0;
  const errorSamples = [];

  async function worker() {
    while (true) {
      const currentIndex = nextIndex++;
      if (currentIndex >= TOTAL_REQUESTS) break;

      const clientId = `load-client-${currentIndex}`;
      try {
        await openAndAbortConnection(BASE_URL, clientId);
      } catch (err) {
        unexpectedErrors++;
        if (errorSamples.length < 5) {
          errorSamples.push(err.message);
        }
      }

      completed++;
      if (completed % 500 === 0 || completed === TOTAL_REQUESTS) {
        const elapsedSec = ((Date.now() - startTime) / 1000).toFixed(1);
        const rate = (completed / Math.max(0.1, (Date.now() - startTime) / 1000)).toFixed(0);
        console.log(`  Progress: ${completed}/${TOTAL_REQUESTS} connections processed (${elapsedSec}s elapsed, ~${rate} req/s)`);
      }
    }
  }

  const workers = [];
  for (let i = 0; i < Math.min(CONCURRENCY, TOTAL_REQUESTS); i++) {
    workers.push(worker());
  }

  await Promise.all(workers);
  const totalDuration = ((Date.now() - startTime) / 1000).toFixed(2);
  const avgRate = (completed / Math.max(0.01, (Date.now() - startTime) / 1000)).toFixed(0);

  console.log('\n[3/3] Load test completed.');
  console.log(`  Duration:             ${totalDuration}s`);
  console.log(`  Completed requests:   ${completed}`);
  console.log(`  Average throughput:   ${avgRate} req/s`);
  console.log(`  Unexpected errors:    ${unexpectedErrors}`);

  if (errorSamples.length > 0) {
    console.log('  Sample errors:');
    errorSamples.forEach((msg, idx) => console.log(`    ${idx + 1}. ${msg}`));
  }

  // Allow short settling window for TCP teardown
  await new Promise((r) => setTimeout(r, 500));

  try {
    const postMetrics = await fetchMetrics(BASE_URL);
    console.log('\nPost-Load Server Metrics:');
    console.log(`  Listener count:  ${postMetrics.listenerCount}`);
    console.log(`  Heap used:       ${(postMetrics.memoryUsage.heapUsed / 1024 / 1024).toFixed(2)} MB`);
    console.log(`  Heap total:      ${(postMetrics.memoryUsage.heapTotal / 1024 / 1024).toFixed(2)} MB`);
    console.log(`  RSS:             ${(postMetrics.memoryUsage.rss / 1024 / 1024).toFixed(2)} MB`);
  } catch (err) {
    console.warn(`Warning: Could not fetch post-test metrics: ${err.message}`);
  }

  if (unexpectedErrors > 0 && unexpectedErrors > TOTAL_REQUESTS * 0.05) {
    console.error('\nLoad test finished with excessive unexpected errors.');
    process.exit(1);
  }

  console.log('\nLoad test finished successfully.');
  process.exit(0);
}

runLoadTest().catch((err) => {
  console.error('Fatal load test error:', err);
  process.exit(1);
});
