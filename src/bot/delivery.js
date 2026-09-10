'use strict';
const { digest, sessionKey } = require('./contract');
const redact = require('../redact');
const { setTimeout: delay } = require('timers/promises');
function split(text, limit, markdown = false) {
  let rest = String(text), fence = ''; const parts = [];
  while (rest.length) {
    const prefix = fence ? '```' + fence + '\n' : '';
    const room = limit - prefix.length - 8;
    let end = Math.min(rest.length, room);
    if (end < rest.length) {
      const line = rest.lastIndexOf('\n', end); if (line > room / 2) end = line + 1;
      if (/[\uD800-\uDBFF]/.test(rest[end - 1])) end--;
    }
    const chunk = rest.slice(0, end); rest = rest.slice(end);
    if (markdown) for (const m of chunk.matchAll(/^```([^\n]*)/gm)) fence = fence ? '' : (m[1].trim().slice(0, 32) || ' ');
    parts.push(prefix + chunk + (fence ? '\n```' : ''));
  }
  return parts;
}
class Delivery {
  constructor(store, getAdapter, { sleep = delay } = {}) { this.store = store; this.getAdapter = getAdapter; this.sleep = sleep; this.chains = new Map(); this.abort = new AbortController(); }
  stop() { this.abort.abort(); }
  destination(target) {
    return Object.fromEntries(['platform', 'accountId', 'chatId', 'threadId', 'senderId', 'replyTo', 'timestamp', 'guildId', 'channelId', 'kind', 'addressed'].map(k => [k, target[k] ?? '']));
  }
  enqueue(target, fn) {
    const key = digest([target.platform, target.accountId, target.chatId, target.threadId]);
    const work = (this.chains.get(key) || Promise.resolve()).catch(() => {}).then(fn);
    this.chains.set(key, work);
    work.finally(() => { if (this.chains.get(key) === work) this.chains.delete(key); }).catch(() => {});
    return work;
  }
  sendMessage(target, text, { id, turnId = '', prompt = null, kind = 'text' } = {}) {
    if (!id) throw new Error('delivery requires an idempotency key');
    return this.enqueue(target, () => this.send(target, text, { id, turnId, prompt, kind }));
  }
  sendFile(target, file, { id, turnId, artifactId }) {
    if (!id) throw new Error('file delivery requires an idempotency key');
    return this.enqueue(target, async () => {
      const key = digest([target.platform, target.accountId, target.chatId, target.threadId, id, artifactId]);
      let row = this.store.data.deliveries[key];
      if (row && row.state !== 'pending') return [row];
      if (!row) {
        this.store.trim('deliveries'); row = this.store.data.deliveries[key] = { id: key, turnId, artifactId,
          target: this.destination(target), state: 'pending', attempts: 0, at: Date.now(), kind: 'media' };
        this.store.save();
      }
      await this.attempt(row, { type: 'media', target, file, id: key }); return [row];
    });
  }
  async send(target, text, { id, turnId, prompt, kind = 'text' }) {
    const adapter = this.getAdapter(target.platform, target.accountId);
    if (!adapter) throw new Error('messaging adapter unavailable');
    const clean = redact.text(String(text));
    const bounded = clean.length > 128000 ? clean.slice(0, 128000) + '\n[Response shortened; full response is saved in the LAIN session.]' : clean;
    const parts = split(bounded, adapter.caps.maxLength, adapter.caps.format === 'markdown');
    const rows = []; let previous = '';
    // Persist every fragment before sending; recovery requires a known ACK for
    // its predecessor. A crashed model turn is never repeated to recover text.
    for (let i = 0; i < parts.length; i++) {
      const key = digest([target.platform, target.accountId, target.chatId, target.threadId, id, i]);
      let row = this.store.data.deliveries[key];
      if (!row) {
        this.store.trim('deliveries');
        row = this.store.data.deliveries[key] = { id: key, turnId, target: this.destination(target), previous,
          state: 'pending', kind: prompt ? 'prompt' : kind, text: parts[i], attempts: 0, at: Date.now() };
      }
      rows.push(row); previous = key;
    }
    this.store.save();
    const receipts = [];
    for (let i = 0; i < rows.length; i++) {
      const row = rows[i];
      if (row.state === 'pending') await this.attempt(row, { type: prompt && i === rows.length - 1 ? 'prompt' : 'send', target, text: row.text, prompt, id: row.id });
      receipts.push(row); if (row.state !== 'delivered') break;
    }
    return receipts;
  }
  async attempt(row, action) {
    const adapter = this.getAdapter(row.target.platform, row.target.accountId);
    if (!adapter) return;
    while (row.attempts < 3) {
      if (this.abort.signal.aborted) return;
      row.state = 'sending'; row.attempts++; this.store.save();
      try {
        const result = await adapter.action(action);
        if (!result?.messageId) throw new Error('delivery acknowledgement missing');
        row.messageId = String(result.messageId); row.state = 'delivered'; delete row.text; break;
      } catch (e) {
        if (e.status === 429 && row.attempts < 3 && Number.isFinite(e.retryAfter) && e.retryAfter <= 60) {
          row.state = 'pending'; row.retryAt = Date.now() + Math.max(1, e.retryAfter * 1000); this.store.save();
          try { await this.sleep(Math.max(1, e.retryAfter * 1000), undefined, { signal: this.abort.signal }); } catch { return; }
          continue;
        }
        row.state = e.definitive ? 'failed' : 'uncertain'; row.error = e.status ? `platform HTTP ${e.status}` : 'delivery acknowledgement unavailable'; break;
      }
    }
    this.store.save();
  }
  async recover(canSend) {
    for (const row of Object.values(this.store.data.deliveries)) {
      if (row.state !== 'pending' || !canSend(row.target)) continue;
      if (row.kind === 'prompt') { row.state = 'failed'; delete row.text; this.store.save(); continue; }
      if (row.kind !== 'text' || typeof row.text !== 'string') continue;
      if (row.previous && this.store.data.deliveries[row.previous]?.state !== 'delivered') continue;
      if (row.retryAt > Date.now()) continue;
      await this.enqueue(row.target, () => this.attempt(row, { type: 'send', target: row.target, text: row.text, id: row.id }));
    }
  }
  review(target) {
    const rows = Object.values(this.store.data.deliveries).filter(r => sessionKey(r.target) === sessionKey(target));
    const uncertain = rows.filter(r => r.state === 'uncertain').length;
    const failed = rows.filter(r => r.state === 'failed').length;
    const retryable = rows.some(r => ['uncertain', 'failed'].includes(r.state) && r.kind === 'text' && typeof r.text === 'string' && !r.retryRequested);
    return [uncertain ? `⚠ Delivery status unknown · ${uncertain} message fragment(s) may have been sent.` : 'No unknown deliveries in this conversation.',
      ...(failed ? [`${failed} message fragment(s) failed.`] : []),
      ...(retryable ? ['/retry explicitly resends the latest unconfirmed text fragment and may create a duplicate.'] : [])].join('\n');
  }
  async retryLatest(target, requestId) {
    // A fresh, authorized inbound command is the only authority to retry.
    // Preserve the original unknown receipt; never rewrite history as failed.
    const row = Object.values(this.store.data.deliveries).reverse().find(r => sessionKey(r.target) === sessionKey(target)
      && ['uncertain', 'failed'].includes(r.state) && r.kind === 'text' && typeof r.text === 'string' && !r.retryRequested);
    if (!row) return 'No unconfirmed text fragment is available to retry. Use /send again for a file.';
    row.retryRequested = requestId; this.store.save();
    const result = await this.sendMessage({ ...row.target, timestamp: target.timestamp }, row.text, { id: `retry:${requestId}`, turnId: row.turnId });
    return result.length && result.every(r => r.state === 'delivered')
      ? 'Explicit retry acknowledged. The original message may also have been sent. Use /delivery to review.'
      : '⚠ Delivery status unknown or failed · retry will not be repeated automatically. Use /delivery to review.';
  }
}
module.exports = { Delivery, split };
