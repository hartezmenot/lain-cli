'use strict';

const path = require('path');
const { event, authorized, sessionKey, eventKey, digest } = require('./contract');
const { Store } = require('./store');
const { Delivery } = require('./delivery');
const { Prompts } = require('./prompts');

class Gateway {
  constructor({ cfg = {}, cwd = process.cwd(), dir, registry, runtimeFactory } = {}) {
    this.cfg = cfg; this.cwd = cwd; this.registry = registry;
    this.store = new Store(dir || path.join(require('../config').configDir(), 'bot'));
    this.runtimeFactory = runtimeFactory || (opts => new (require('./runtime').Runtime)(opts));
    this.adapters = new Map(); this.unavailable = []; this.runtimes = new Map(); this.queues = new Map(); this.busy = new Set();
    this.tasks = new Set(); this.active = 0; this.stopping = false;
    this.maxActive = Math.max(1, Math.min(8, Number(cfg.bot?.maxConcurrent) || 2));
    this.delivery = new Delivery(this.store, (platform, account) => {
      const adapter = this.adapters.get(`${platform}:${account}`);
      return adapter && !['unavailable', 'stopped'].includes(adapter.state) ? adapter : null;
    });
    this.prompts = new Prompts(this.delivery);
  }
  async start() {
    if (this.started) { if (this.stopping) throw new Error('create a fresh gateway after shutdown'); return this.status(); }
    this.started = true;
    this.stopping = false;
    for (const [platform, settings] of Object.entries(this.cfg.bot?.platforms || {})) {
      if (!settings.enabled) continue;
      const key = `${platform}:${settings.accountId || 'default'}`;
      try {
        const adapter = this.registry.create(platform, settings);
        adapter.settings = settings; adapter.accountId = settings.accountId || 'default';
        this.adapters.set(key, adapter);
        await adapter.start(e => this.receive(e));
        this.store.account(key, adapter.identity);
      } catch (error) {
        const reason = require('../redact').text(String(error?.message || 'adapter could not start')).slice(0, 180);
        const adapter = this.adapters.get(key);
        if (adapter) { await adapter.stop().catch(() => {}); adapter.state = 'unavailable'; adapter.reason = reason; }
        else this.unavailable.push({ platform, accountId: settings.accountId || 'default', state: 'unavailable', reason });
      }
    }
    await this.delivery.recover(target => {
      const adapter = this.adapters.get(`${target.platform}:${target.accountId}`);
      return adapter && authorized(target, adapter.settings);
    });
    for (const [id, row] of Object.entries(this.store.data.inbox)) {
      const adapter = row.event && this.adapters.get(`${row.event.platform}:${row.event.accountId}`);
      if (row.state === 'queued' && row.event && adapter && !['unavailable', 'stopped'].includes(adapter.state)) this.enqueue(id, row.event);
    }
    this.pump(); return this.status();
  }
  status() {
    return { state: this.stopping ? 'stopped' : 'running', active: this.active,
      queued: [...this.queues.values()].reduce((n, q) => n + q.length, 0),
      platforms: [...this.adapters.values()].map(a => ({ platform: a.caps.platform, accountId: a.accountId, state: a.state || 'starting', reason: a.reason || '', caps: a.caps,
        accountFingerprint: a.identity ? digest([a.caps.platform, String(a.accountId || 'default'), String(a.identity)]).slice(0, 24) : '', diagnostics: diagnostics(a) })).concat(this.unavailable),
      pendingDeliveries: Object.values(this.store.data.deliveries).filter(r => r.state === 'pending').length,
      uncertain: Object.values(this.store.data.deliveries).filter(r => r.state === 'uncertain').length,
      interrupted: Object.values(this.store.data.inbox).filter(r => r.state === 'interrupted').length };
  }
  async receive(raw) {
    if (this.stopping) return { accepted: false };
    let e; try { e = event(raw); } catch { return { accepted: false }; }
    const adapter = this.adapters.get(`${e.platform}:${e.accountId}`);
    if (!adapter || !authorized(e, adapter.settings)) return { accepted: false };
    if (!e.text.trim() && !e.attachments.length && !e.promptResponse) return { accepted: false };
    this.store.account(`${e.platform}:${e.accountId}`, adapter.identity);
    const key = sessionKey(e), id = eventKey(e);
    if (this.store.data.inbox[id]) return { accepted: true, duplicate: true };
    const cancel = /^\/(?:cancel|bg\s+stop)\s+(\d+)$/.exec(e.text.trim());
    const control = cancel || e.promptResponse || /^\/answer\b/.test(e.text) || /^\/?stop$/i.test(e.text.trim()) || /^\/steer\s+/.test(e.text);
    if (!control && ((this.queues.get(key)?.length || 0) >= 8 || [...this.queues.values()].reduce((n, q) => n + q.length, 0) >= 128)) return { accepted: false, busy: true };
    if (!this.store.admit(id, e)) return { accepted: true, duplicate: true };
    if (control) {
      if (cancel) this.runtimes.get(key)?.cancelJob(cancel[1]);
      else if (/^\/?stop$/i.test(e.text.trim())) {
        this.runtimes.get(key)?.stop(); this.prompts.cancel(key);
        for (const waiting of this.queues.get(key) || []) this.store.settle(waiting.id, 'done');
        this.queues.delete(key);
      } else if (/^\/steer\s+/.test(e.text)) this.runtimes.get(key)?.steer(e.text.replace(/^\/steer\s+/, ''));
      else this.prompts.resolve(e);
      this.store.settle(id, 'done'); return { accepted: true };
    }
    this.enqueue(id, e); this.pump(); return { accepted: true };
  }
  enqueue(id, e) { const key = sessionKey(e); if (!this.queues.has(key)) this.queues.set(key, []); this.queues.get(key).push({ id, e }); }
  pump() {
    if (this.stopping) return;
    for (const [key, queue] of this.queues) {
      if (this.active >= this.maxActive) break;
      if (!queue.length || this.busy.has(key)) continue;
      const item = queue.shift(); this.queues.delete(key); if (queue.length) this.queues.set(key, queue);
      this.busy.add(key); this.active++;
      const work = this.run(key, item).catch(() => {}).finally(() => {
        this.active--; this.busy.delete(key); this.tasks.delete(work); this.pump();
      });
      this.tasks.add(work);
    }
  }
  async run(key, { id, e }) {
    const adapter = this.adapters.get(`${e.platform}:${e.accountId}`);
    // Config changes and queued recovery cannot bypass current authorization.
    if (!adapter || !authorized(e, adapter.settings)) { this.store.settle(id, 'denied'); return; }
    this.store.settle(id, 'running');
    const notify = (text, deliveryId) => this.delivery.sendMessage(e, text, { id: deliveryId, turnId: id,
      kind: /^\/(?:delivery|retry|send)\b/.test(e.text.trim()) ? 'notice' : 'text' });
    let timer;
    try {
      let runtime = this.runtimes.get(key);
      if (!runtime) {
        if (this.runtimes.size >= 128) throw new Error('active conversation capacity reached');
        const sessionId = this.store.data.sessions[key];
        runtime = this.runtimeFactory({ cfg: this.cfg, cwd: this.cwd, sessionId, ask: (target, q, signal) => this.prompts.ask(target, q, signal),
          prepareInput: (app, target) => require('./media').ingress(adapter, app, target),
          deliveryStatus: target => this.delivery.review(target), retryDelivery: target => this.delivery.retryLatest(target, eventKey(target)),
          sendArtifact: (app, target, artifactId) => require('./media').sendArtifact(adapter, this.delivery, app, target, artifactId, `artifact:${eventKey(target)}`) });
        this.store.bind(key, () => runtime.id); this.runtimes.set(key, runtime);
      }
      if (adapter.caps.typing) {
        const typing = () => adapter.action({ type: 'typingStart', target: e }).catch(() => {});
        typing(); timer = setInterval(typing, 6000);
      }
      const text = await runtime.run(e, notify);
      if (!this.stopping && text) await notify(text, `turn:${id}`);
      this.store.settle(id, 'done');
    } catch {
      this.store.settle(id, 'interrupted');
      if (!this.stopping) await notify('LAIN could not complete this turn. Check the local bot status before retrying.', `error:${id}`).catch(() => {});
    } finally {
      clearInterval(timer);
      if (adapter.caps.typing) await adapter.action({ type: 'typingStop', target: e }).catch(() => {});
    }
  }
  async stop() {
    this.stopping = true; this.prompts.cancel(); this.delivery.stop();
    for (const r of this.runtimes.values()) r.stop();
    await Promise.allSettled([...this.tasks]);
    await Promise.allSettled([...this.runtimes.values()].map(r => r.close()));
    await Promise.allSettled([...this.adapters.values()].map(a => a.stop()));
    this.runtimes.clear(); this.queues.clear();
  }
}
function diagnostics(adapter) {
  let raw; try { raw = adapter.diagnostics?.() || {}; } catch { return {}; }
  return Object.fromEntries(['activeSession', 'heartbeatHealthy', 'gatewayReachable', 'intents', 'localListener', 'publicWebhookVerified',
    'inboundAccepted', 'deliveryAcknowledged', 'heartbeatAgeMs', 'reconnects', 'duplicates'].filter(k => typeof raw[k] === 'boolean' || (typeof raw[k] === 'number' && Number.isFinite(raw[k])))
    .map(k => [k, raw[k]]));
}
module.exports = { Gateway };
