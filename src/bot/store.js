'use strict';

const fs = require('fs');
const path = require('path');
// Routing and transport receipts only. Conversations remain ordinary LAIN Sessions.
class Store {
  constructor(dir) {
    this.file = path.join(dir, 'transport.json');
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    this.data = { version: 1, sessions: {}, inbox: {}, deliveries: {} };
    if (fs.existsSync(this.file)) {
      const value = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      if (value.version !== 1 || !value.sessions || !value.inbox || !value.deliveries) throw new Error('invalid bot transport store');
      this.data = value;
    }
    for (const row of Object.values(this.data.deliveries)) if (row.state === 'sending') row.state = 'uncertain';
    this.data.accounts ||= {};
    // A model/tool turn interrupted by process death is never automatically repeated.
    for (const row of Object.values(this.data.inbox)) if (row.state === 'running') row.state = 'interrupted';
    this.save();
  }
  save() {
    const temp = this.file + '.tmp';
    fs.writeFileSync(temp, JSON.stringify(this.data), { mode: 0o600 });
    fs.renameSync(temp, this.file);
  }
  trim(table, max = 2048) {
    const rows = Object.entries(this.data[table]);
    const dependencies = new Set(rows.filter(([, row]) => ['pending', 'sending', 'uncertain'].includes(row.state)).map(([, row]) => row.previous));
    for (const [key, row] of rows) {
      if (Object.keys(this.data[table]).length < max) break;
      if (!dependencies.has(key) && ['done', 'delivered', 'failed', 'denied'].includes(row.state)) delete this.data[table][key];
    }
    if (Object.keys(this.data[table]).length >= max) throw new Error('bot transport capacity reached');
  }
  bind(key, make) {
    if (this.data.sessions[key]) return this.data.sessions[key];
    if (Object.keys(this.data.sessions).length >= 10000) throw new Error('bot session capacity reached');
    const session = make(); this.data.sessions[key] = session; this.save(); return session;
  }
  account(key, identity) {
    if (!identity) return;
    if (this.data.accounts[key] && this.data.accounts[key] !== identity) throw new Error('bot account changed; configure a new accountId');
    if (!this.data.accounts[key]) { this.data.accounts[key] = identity; this.save(); }
  }
  admit(key, event) {
    if (this.data.inbox[key]) return false;
    this.trim('inbox'); this.data.inbox[key] = { state: 'queued', event, at: Date.now() }; this.save(); return true;
  }
  settle(key, state) {
    const row = this.data.inbox[key]; row.state = state;
    if (state !== 'queued' && state !== 'running') delete row.event;
    this.save();
  }
}
module.exports = { Store };
