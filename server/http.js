import https from 'node:https';

export const USER_AGENT =
  'OutageDesk/1.0 (internal outage dashboard; +https://github.com/dzee3/outage)';
const MAX_BYTES = 24 * 1024 * 1024;

export class HttpError extends Error {
  constructor(status, url) {
    super(`HTTP ${status}`);
    this.status = status;
    this.url = url;
  }
}

/**
 * GET/POST JSON with a deadline, a byte cap and no redirects.
 * @param {string} url
 * @param {{method?: string, headers?: object, body?: string, timeoutMs?: number,
 *          tls12?: boolean, fetchImpl?: Function}} [options]
 */
export async function requestJson(
  url,
  {
    method = 'GET',
    headers = {},
    body,
    timeoutMs = 20_000,
    tls12 = false,
    fetchImpl = globalThis.fetch,
  } = {},
) {
  if (tls12 && fetchImpl === globalThis.fetch)
    return requestJsonTls12(url, { method, headers, body, timeoutMs });
  let response;
  try {
    response = await fetchImpl(url, {
      method,
      body,
      redirect: 'error',
      signal: AbortSignal.timeout(timeoutMs),
      headers: { Accept: 'application/json', 'User-Agent': USER_AGENT, ...headers },
    });
  } catch (error) {
    // "fetch failed" alone says nothing; name the network cause.
    const cause = error?.cause?.code || error?.cause?.message || error?.name;
    throw new Error(
      error?.name === 'TimeoutError'
        ? `No answer within ${Math.round(timeoutMs / 1000)} s`
        : `Cannot connect (${cause || error.message})`,
    );
  }
  if (!response.ok) {
    await response.body?.cancel?.();
    throw new HttpError(response.status, url);
  }
  const length = Number(response.headers.get?.('content-length'));
  if (Number.isFinite(length) && length > MAX_BYTES)
    throw new Error('Response too large');
  const text = await response.text();
  if (text.length > MAX_BYTES) throw new Error('Response too large');
  return JSON.parse(text);
}

/**
 * Like requestJson but returns {status, headers, text} and never throws on
 * HTTP status (callers decide). Used for XML/KML feeds and cookie handshakes.
 */
export async function requestRaw(
  url,
  { method = 'GET', headers = {}, body, timeoutMs = 20_000, fetchImpl = globalThis.fetch } = {},
) {
  let response;
  try {
    response = await fetchImpl(url, {
      method,
      body,
      redirect: 'manual',
      signal: AbortSignal.timeout(timeoutMs),
      headers: { 'User-Agent': USER_AGENT, ...headers },
    });
  } catch (error) {
    const cause = error?.cause?.code || error?.cause?.message || error?.name;
    throw new Error(
      error?.name === 'TimeoutError'
        ? `No answer within ${Math.round(timeoutMs / 1000)} s`
        : `Cannot connect (${cause || error.message})`,
    );
  }
  const text = await response.text();
  if (text.length > MAX_BYTES) throw new Error('Response too large');
  return { status: response.status, headers: response.headers, text };
}

/** requestRaw that insists on HTTP 200 and returns the body text. */
export async function requestText(url, options) {
  const r = await requestRaw(url, options);
  if (r.status !== 200) throw new HttpError(r.status, url);
  return r.text;
}

/**
 * IODA's API misbehaves with TLS 1.3 clients (the reference client pins 1.2),
 * so this one path uses node:https with maxVersion TLSv1.2.
 */
function requestJsonTls12(url, { method, headers, body, timeoutMs }) {
  return new Promise((resolve, reject) => {
    const req = https.request(
      url,
      {
        method,
        maxVersion: 'TLSv1.2',
        timeout: timeoutMs,
        headers: { Accept: 'application/json', 'User-Agent': USER_AGENT, ...headers },
      },
      (res) => {
        if (res.statusCode !== 200) {
          res.resume();
          reject(new HttpError(res.statusCode, url));
          return;
        }
        let size = 0;
        const chunks = [];
        res.on('data', (chunk) => {
          size += chunk.length;
          if (size > MAX_BYTES) {
            req.destroy(new Error('Response too large'));
            return;
          }
          chunks.push(chunk);
        });
        res.on('end', () => {
          try {
            resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
          } catch (error) {
            reject(error);
          }
        });
      },
    );
    req.on('timeout', () => req.destroy(new Error('Timed out')));
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}
