import http from 'http';

/**
 * Helper to call the internal api_tool service. The API tool lives at
 * http://localhost:8674. Given an API name and params, this function
 * constructs the query string and returns the result field of the JSON
 * response. It does not handle errors gracefully; errors will reject
 * the promise. In a production relay you should add retries and proper
 * error handling.
 *
 * @param {string} name The API name (path) to call, e.g. "/connector_x/search_emails".
 * @param {Object} params The parameters to pass to the API call.
 * @returns {Promise<any>} The `result` property from the API response.
 */
export function callApi(name, params = {}) {
  return new Promise((resolve, reject) => {
    // Encode both name and params as query parameters. The params object
    // must be stringified before encoding. Use encodeURIComponent to
    // handle spaces and special characters.
    const query = new URLSearchParams({
      name,
      params: JSON.stringify(params)
    }).toString();
    const url = `http://localhost:8674/call_api?${query}`;
    http.get(url, res => {
      let data = '';
      res.on('data', chunk => {
        data += chunk;
      });
      res.on('end', () => {
        try {
          const parsed = JSON.parse(data);
          // The API response is expected to include a `result` field. If
          // there is an error, it will be in parsed.error. We simply
          // resolve with the result for now.
          resolve(parsed.result);
        } catch (err) {
          reject(err);
        }
      });
    }).on('error', err => {
      reject(err);
    });
  });
}

/**
 * Process a run by executing each task sequentially. For each task, this
 * function determines which connector to call based on the `source`
 * field and passes the task's params through to the API. The collected
 * results are attached to the run's artifacts. The run's status is
 * updated to "running" while processing and "complete" when finished.
 * If any task throws an error, the error message is pushed to the
 * run's errors array and the status is set to "partial".
 *
 * @param {Object} runs The in-memory runs store from index.js.
 * @param {string} run_id The identifier of the run to process.
 */
export async function processRun(runs, run_id) {
  const run = runs[run_id];
  if (!run) return;
  run.status = 'running';
  const payload = run.payload || {};
  const tasks = payload.tasks || [];
  for (const task of tasks) {
    try {
      const { source, mode = 'fetch', params = {} } = task;
      const [kind, name] = (source || '').split(':');
      let result;
      if (kind === 'official_api') {
        switch (name) {
          case 'gmail':
            // Use the Gmail search_emails endpoint. Expect params.query and
            // optionally params.max_results. See API doc for details.
            result = await callApi('/connector_2128aebfecb84f64a069897515042a44/search_emails', params);
            break;
          case 'drive':
            // Use the Google Drive search endpoint. params.query can be used
            // to search by filename or content.
            result = await callApi('/connector_5f3c8c41a1e54ad7a76272c89e2554fa/search', params);
            break;
          case 'calendar':
            // Use the Calendar search_events endpoint. Provide time_min
            // and time_max as ISO strings and optionally max_results.
            result = await callApi('/connector_947e0d954944416db111db556030eea6/search_events', params);
            break;
          case 'notion':
            // Use the Notion search endpoint. `query` and optional
            // `query_type` = 'internal' or 'users'.
            result = await callApi('/link_6886ea546c548191a0ec455bd2fe0e70/connector_37316be7febe4224b3d31465bae4dbd7/search', params);
            break;
          case 'canva':
            // Use Canva search endpoint. `query` can be a design name or
            // keywords. For folder listing, use list_folder_items.
            result = await callApi('/connector_ef718304ffe64e31947b71887e3d51fa/search', params);
            break;
          case 'github':
            // For GitHub, the minimal skeleton does not implement search. You
            // can add a GitHub connector here or call your own API if you
            // have one. For demonstration, skip.
            result = { note: 'GitHub integration not implemented in minimal processor' };
            break;
          default:
            throw new Error(`Unsupported official_api source: ${name}`);
        }
      } else if (kind === 'vendor') {
        // Vendors such as NewsAPI or SerpAPI can be added here. For now
        // simply indicate vendor calls are not implemented.
        result = { note: `Vendor source ${name} not implemented` };
      } else if (kind === 'site') {
        // Site scraping would involve headless browser; not implemented.
        result = { note: `Site source ${name} not implemented` };
      } else {
        throw new Error(`Unknown source type: ${source}`);
      }
      // Append a normalized artifact. We include source and current
      // timestamp. In a full implementation you might also include a
      // canonical URL for the data.
      run.artifacts.push({
        source,
        ts: new Date().toISOString(),
        data: result
      });
    } catch (err) {
      // Record error and continue processing remaining tasks.
      run.errors.push(err.message || String(err));
    }
  }
  // Determine final status.
  run.status = run.errors.length ? (run.artifacts.length ? 'partial' : 'failed') : 'complete';
}
