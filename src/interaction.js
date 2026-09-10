'use strict';

// Presentation seam only. Trust and desktop permissions still decide grants.
const { AsyncLocalStorage } = require('async_hooks');
const scope = new AsyncLocalStorage();
function port(app) { const s = scope.getStore(); return s?.app === app ? s.port : app?.interaction; }
function available(app) { return Boolean(port(app) || app?.ui?.enabled); }
function ask(app, question, signal) {
  const p = port(app);
  if (p) return p.ask(question, signal || p.signal || app.abort?.signal);
  if (!app?.ui?.enabled) return Promise.resolve(null);
  return app.ui.ask(require('./ui/panel').askAdapter(question));
}
function run(app, interaction, fn) { return scope.run({ app, port: interaction }, fn); }
async function prepareInput(app, text) { return port(app)?.prepareInput ? port(app).prepareInput(text) : text; }
module.exports = { available, ask, port, run, prepareInput };
