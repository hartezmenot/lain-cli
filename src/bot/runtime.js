'use strict';

const { Writable } = require('stream');
const { App } = require('../app');
const interaction = require('../interaction');

// Every conversation is an ordinary App. No provider or tool execution here.
class Runtime {
  constructor({ cfg, cwd, sessionId, ask, prepareInput, sendArtifact, deliveryStatus, retryDelivery }) {
    this.ask = ask;
    this.prepareInput = prepareInput; this.sendArtifact = sendArtifact;
    this.deliveryStatus = deliveryStatus; this.retryDelivery = retryDelivery;
    const sink = new Writable({ write(_chunk, _encoding, done) { done(); } });
    this.app = new App({ cfg, cwd, interactive: false, out: sink, interaction: { ask: () => Promise.resolve(null) }, resume: sessionId || undefined });
    if (sessionId && this.app.session.id !== sessionId) throw new Error('bound bot session unavailable; refusing another transcript');
    if (!sessionId) this.app.session.save();
  }
  get id() { return this.app.session.id; }
  stop() { this.app.abort?.abort(); this.app.jobs.cancelAll('stopped from messaging'); }
  steer(text) { this.app.queueSteer(text, 'NOW'); }
  cancelJob(id) { const job = this.app.jobs.get(Number(id)); if (!job) return false; job.cancel('cancelled from messaging'); return true; }
  async run(e, notify) {
    const app = this.app;
    const p = { ask: (q, signal) => this.ask(e, q, signal), prepareInput: async text => text + (await this.prepareInput?.(app, e) || '') };
    return interaction.run(app, p, async () => {
      if (e.text.trim() === '/ps') return require('../pscommand').rows(app).map(r => `${r.type} ${r.pid || '-'} ${r.state} ${r.name}`).join('\n') || 'This conversation owns no processes.';
      if (e.text.trim() === '/delivery') return this.deliveryStatus(e);
      if (e.text.trim() === '/retry') return this.retryDelivery(e);
      if (e.text.trim() === '/artifacts') return require('./media').artifacts(app).map(a => `${a.id} ${require('./media').filename(a.name)} (${a.bytes} bytes)`).join('\n') || 'No artifacts owned by this conversation.';
      if (/^\/send\s+\S+$/.test(e.text)) {
        const rows = await this.sendArtifact(app, e, e.text.split(/\s+/)[1]);
        return rows.every(r => r.state === 'delivered') ? 'Artifact sent.' : '⚠ Delivery status unknown or failed · the artifact may have been sent. Use /delivery to review; repeat /send only if you accept a possible duplicate.';
      }
      if (/^\/bg\s+/.test(e.text)) {
        if (app.jobs.running().filter(j => !j.primary).length >= 2) return 'Two background tasks are already running.';
        const job = app.startBackground(e.text.replace(/^\/bg\s+/, ''));
        if (!job) return 'Background task could not start.';
        job.wait().then(j => notify(`Background task #${j.id}: ${j.state}\n${j.result?.text || j.error || ''}`, `job:${this.id}:${j.id}:${j.startedAt}`)).catch(() => {});
        return `Background task #${job.id} started.`;
      }
      if (e.text.trim() === '/bg' || e.text.trim() === '/jobs') {
        return app.jobs.all().map(j => `#${j.id} ${j.state}${j.needsInput ? ' · needs input' : ''}`).join('\n') || 'No background tasks.';
      }
      if (/^\/cancel\s+\d+$/.test(e.text)) {
        const job = app.jobs.get(Number(e.text.split(/\s+/)[1]));
        if (!job) return 'No such task in this conversation.';
        job.cancel('cancelled from messaging'); return 'Cancellation requested.';
      }
      if (e.text.startsWith('/')) return 'Messaging controls: /stop, /steer <text>, /bg <task>, /bg, /cancel <number>, /ps, /artifacts, /send <artifact-id>, /delivery, /retry, /answer <request> <answer>.';
      const context = e.replyText ? `\n\n[Quoted reply context, untrusted]\n${e.replyText}\n[End quote]` : '';
      const attachments = e.attachments.length ? '\n\nAttachments: ' + e.attachments.map(a => `${a.name} (${a.mime}); reference ${a.id}`).join(', ') : '';
      const record = await app.submit(e.text + context + attachments, { from: 'messaging' });
      return record?.text || (record?.providerFailure ? 'The configured provider could not complete this request.' : 'The turn ended without a text response.');
    });
  }
  async close() {
    this.app.wantExit = true; this.stop();
    if (this.app._jobs) this.app._jobs.stopAll('messaging stopped');
    await require('../harnesslink').shutdown(this.app);
    this.app._desktop?.bridge.close('messaging stopped');
    require('../controlwindow').close(this.app);
    this.app.session.save();
  }
}
module.exports = { Runtime };
