'use strict';
const { setTimeout: sleep } = require('timers/promises');
const redact = require('../redact');
function secret(envName) {
  if (typeof envName !== 'string' || !/^[A-Z][A-Z0-9_]*$/.test(envName)) throw new Error('configure a credential environment variable name');
  const value = process.env[envName];
  if (!value) throw new Error('messaging credential is unavailable');
  redact.register(value); return value;
}
class Http {
  constructor({ base, authorization, fetch = globalThis.fetch }) { this.base = base; this.authorization = authorization; this.fetch = fetch; this.until = 0; }
  async request(route, { method = 'GET', body, headers = {}, form } = {}) {
    if (!route.startsWith('/') || route.startsWith('//')) throw new Error('invalid API route');
    if (this.until > Date.now()) await sleep(Math.min(this.until - Date.now(), 60000));
    if (this.until > Date.now()) throw Object.assign(new Error('platform rate limit'), { status: 429, definitive: true, retryAfter: (this.until - Date.now()) / 1000 });
    let response;
    try {
      response = await this.fetch(this.base + route, { method, redirect: 'error', signal: AbortSignal.timeout(20000),
        headers: { Authorization: this.authorization, ...(body && !form ? { 'Content-Type': 'application/json' } : {}), ...headers },
        body: form || (body ? JSON.stringify(body) : undefined) });
    } catch { throw new Error('platform acknowledgement unavailable'); }
    let data = {};
    // Bound platform JSON, including error bodies. Never surface their text.
    const chunks = []; let size = 0;
    try {
      for await (const chunk of response.body || []) {
        size += chunk.length; if (size > 2 * 1024 * 1024) throw new Error('platform response too large'); chunks.push(Buffer.from(chunk));
      }
    } catch { throw new Error('platform acknowledgement unavailable'); }
    try { data = JSON.parse(Buffer.concat(chunks).toString() || '{}'); } catch { if (response.ok) throw new Error('invalid platform acknowledgement'); }
    if (!response.ok) {
      const retryAfter = Number(data.retry_after || response.headers.get('retry-after'));
      if (response.status === 429 && Number.isFinite(retryAfter)) this.until = Date.now() + Math.max(1, retryAfter * 1000);
      throw Object.assign(new Error(`platform HTTP ${response.status}`), { status: response.status,
        definitive: response.status >= 400 && response.status < 500, retryAfter, code: Number.isSafeInteger(data.code) ? data.code : undefined,
        authFailed: response.status === 401 || response.status === 403 || data.error?.code === 190 });
    }
    return data;
  }
}
module.exports = { Http, secret };
