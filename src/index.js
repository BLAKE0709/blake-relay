import http from 'http';
import { v4 as uuid } from 'uuid';
import { processRun } from './jobProcessor.js';

/*
 * Minimal HTTP relay server without external dependencies.
 *
 * This server implements two endpoints:
 *  - POST /relay/run: accepts a JSON body representing a TaskPlan, assigns a run_id,
 *    stores it in memory, and returns a queued response. It expects an Authorization
 *    header with a bearer token matching the RELAY_KEY environment variable.
 *  - GET /relay/status/{run_id}: returns the status of a previously queued run.
 *
 * Note: This is a demonstration only. A production implementation should use
 * proper request parsing, validation, persistent storage, job queues, and
 * concurrency controls. This code is purely illustrative and runs within
 * a static environment without package installation.
 */

// In-memory state for runs. In production, this belongs in a database.
const runs = {};

// Helper to parse JSON bodies. Reads request data and resolves to an object.
function parseJsonBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', chunk => {
      data += chunk;
      // Protect against large payloads
      if (data.length > 1e6) {
        req.connection.destroy();
        reject(new Error('Payload too large'));
      }
    });
    req.on('end', () => {
      try {
        const obj = JSON.parse(data || '{}');
        resolve(obj);
      } catch (err) {
        reject(err);
      }
    });
  });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const method = req.method || 'GET';
  // Basic CORS support: respond with OK to preflight requests
  if (method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type,Authorization'
    });
    res.end();
    return;
  }
  // POST /relay/run
  if (method === 'POST' && url.pathname === '/relay/run') {
    // Check Authorization header
    const authHeader = req.headers['authorization'] || '';
    const token = authHeader.replace(/^Bearer\s+/i, '');
    const relayKey = process.env.RELAY_KEY;
    if (!relayKey || token !== relayKey) {
      res.writeHead(401, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
      res.end(JSON.stringify({ error: 'Unauthorized' }));
      return;
    }
    // Parse the JSON body
    try {
      const payload = await parseJsonBody(req);
      const run_id = 'run_' + uuid();
      runs[run_id] = { status: 'queued', payload: payload, artifacts: [], errors: [] };
      console.log(`Queued run ${run_id}`, payload);
      // Kick off processing asynchronously. Do not await so that the HTTP response returns immediately.
      processRun(runs, run_id).catch(err => {
        console.error('Error processing run', run_id, err);
        const run = runs[run_id];
        if (run) {
          run.errors.push(err.message || String(err));
          run.status = run.artifacts.length ? 'partial' : 'failed';
        }
      });
      res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
      res.end(JSON.stringify({ run_id, status: 'queued', artifacts: [], errors: [] }));
    } catch (err) {
      res.writeHead(400, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
      res.end(JSON.stringify({ error: 'Invalid JSON' }));
    }
    return;
  }
  // GET /relay/status/:run_id
  if (method === 'GET' && url.pathname.startsWith('/relay/status/')) {
    const parts = url.pathname.split('/');
    const run_id = parts.pop();
    const run = runs[run_id];
    if (!run) {
      res.writeHead(404, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
      res.end(JSON.stringify({ error: 'not_found' }));
      return;
    }
    res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
    res.end(JSON.stringify({ run_id, status: run.status, artifacts: run.artifacts, errors: run.errors }));
    return;
  }
  // Fallback 404
  res.writeHead(404, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
  res.end(JSON.stringify({ error: 'not_found' }));
});

const port = parseInt(process.env.PORT || '8080', 10);
server.listen(port, () => {
  console.log(`Minimal relay server listening on port ${port}`);
});
