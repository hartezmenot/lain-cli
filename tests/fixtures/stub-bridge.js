'use strict';

/**
 * A DESKTOP BRIDGE THAT TOUCHES NOTHING.
 *
 * It speaks the real protocol (src/mcp.js) over stdin/stdout and performs no
 * actual desktop action: no screen is captured, no key is pressed, no window is
 * moved. That is exactly what makes it useful — the whole path from the model,
 * through the permission gate, through the bridge client and back can be driven
 * end to end in a test without a machine being controlled by a test.
 *
 * A REAL bridge is a separate program the user supplies. LAIN ships none, and
 * this is not one: it is a protocol double, and it lives under tests/ for that
 * reason.
 *
 * Behaviour can be steered by argv so failure paths are reachable too:
 *   --no-hello      never answer the handshake (connect must time out)
 *   --die           exit immediately after the handshake
 *   --deny <op>     answer that op with ok:false
 *   --caps a,b      advertise only these capabilities
 */

const args = process.argv.slice(2);
const flag = (name) => args.includes(name);
const value = (name, fallback) => {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
};

const CAPS = value('--caps', 'screen.capture,mouse.move,mouse.click,keyboard.type,window.list,window.focus').split(',');
const DENY = value('--deny', '');

let buf = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (d) => {
  buf += d;
  let nl;
  while ((nl = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, nl).trim();
    buf = buf.slice(nl + 1);
    if (line) handle(JSON.parse(line));
  }
});

function reply(obj) { process.stdout.write(JSON.stringify(obj) + '\n'); }

function handle(msg) {
  if (msg.op === 'hello') {
    if (flag('--no-hello')) return;
    reply({ id: msg.id, ok: true, name: 'stub-bridge', version: '0', capabilities: CAPS });
    if (flag('--die')) process.exit(1);
    return;
  }
  if (DENY && msg.op === DENY) { reply({ id: msg.id, ok: false, error: `${msg.op} refused by the bridge` }); return; }
  // Everything else is ACKNOWLEDGED, not performed. The reply says so, so a
  // test that mistook this for a real bridge would fail loudly.
  const params = msg.params || {};
  if (msg.op === 'window.list') {
    reply({ id: msg.id, ok: true, result: [{ id: 'w1', title: 'Stub Window' }, { id: 'w2', title: 'Cheat Engine' }] });
    return;
  }
  if (msg.op === 'screen.capture') {
    reply({ id: msg.id, ok: true, result: { format: 'stub', width: 0, height: 0, note: 'nothing was captured' } });
    return;
  }
  reply({ id: msg.id, ok: true, result: { performed: false, op: msg.op, params, note: 'stub bridge — nothing happened' } });
}
