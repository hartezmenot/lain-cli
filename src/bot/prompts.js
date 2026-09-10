'use strict';

const { randomBytes } = require('crypto');
const { sessionKey } = require('./contract');
class Prompts {
  constructor(delivery, ttl = 120000) { this.delivery = delivery; this.ttl = ttl; this.pending = new Map(); }
  async ask(target, question, signal) {
    if (signal?.aborted) return null;
    const id = randomBytes(12).toString('hex');
    const choices = (question.options || []).slice(0, 12).map(String);
    let finish;
    const answer = new Promise(resolve => { finish = resolve; });
    const close = (value) => { clearTimeout(timer); signal?.removeEventListener('abort', abort); this.pending.delete(id); finish(value); };
    const abort = () => close(null);
    const timer = setTimeout(abort, this.ttl);
    const pending = { key: sessionKey(target), choices, close, delivered: false, answered: false, expires: Date.now() + this.ttl };
    this.pending.set(id, pending);
    signal?.addEventListener('abort', abort, { once: true });
    const text = [question.title || 'LAIN needs your answer', question.question || '',
      ...choices.map((c, i) => `${i + 1}. ${c}`), `Reply: /answer ${id} ${choices.length ? '<number>' : '<your answer>'}\nExpires in ${Math.round(this.ttl / 1000)} seconds. /stop cancels.`].join('\n');
    try {
      const rows = await this.delivery.sendMessage(target, text, { id: `prompt:${id}`, prompt: { id, choices: choices.map(c => require('../redact').text(c)) } });
      if (!rows.length || rows.some(r => r.state !== 'delivered')) close(null);
      else if (this.pending.get(id) === pending) {
        pending.delivered = true;
        if (pending.answered) close(pending.value);
      }
    } catch { close(null); }
    return answer;
  }
  resolve(e) {
    const typed = /^\/answer\s+([a-f0-9]{24})\s+([\s\S]+)$/.exec(e.text.trim());
    const response = e.promptResponse || (typed ? { id: typed[1], value: typed[2] } : null);
    if (!response) return false;
    const row = this.pending.get(response.id);
    if (!row || row.answered || row.key !== sessionKey(e) || row.expires <= Date.now()) return false;
    let value = response.value;
    if (row.choices.length) {
      if (!/^[1-9][0-9]?$/.test(value)) return false;
      value = row.choices[Number(value) - 1]; if (value === undefined) return false;
    }
    row.answered = true; row.value = value;
    if (row.delivered) row.close(value);
    return true;
  }
  cancel(key) { for (const p of this.pending.values()) if (!key || p.key === key) p.close(null); }
}
module.exports = { Prompts };
