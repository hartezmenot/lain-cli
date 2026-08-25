#!/usr/bin/env node
'use strict';

/**
 * LAIN DESKTOP CONTROL — the always-on-top window you watch while LAIN has
 * control of your machine, and the STOP button that takes it away.
 *
 * It is deliberately its own program with almost nothing in it. It reads a
 * state file, draws it, and writes one flag file when you press STOP. It cannot
 * grant permission, cannot extend a grant, and cannot ask for one — the only
 * thing it can do is end control, which is the one direction that is always
 * safe. If LAIN hangs, this still stops it.
 *
 *     node bin/lain-control.js <control-dir>
 */

const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');

const dir = process.argv[2];
if (!dir) { process.stderr.write('usage: lain-control <control-dir>\n'); process.exit(2); }
const STATE = path.join(dir, 'state.json');
const REVOKE = path.join(dir, 'revoke');

const useColor = !process.env.NO_COLOR;
const c = (code) => (s) => (useColor ? `\x1b[${code}m${s}\x1b[0m` : String(s));
const dim = c(2); const bold = c(1); const green = c(32); const red = c(31); const yellow = c(33); const cyan = c(36);

/**
 * ALWAYS ON TOP, best effort, and honest when it fails.
 *
 * There is no portable way to do this, so on Windows it is one PowerShell call
 * into user32. If it does not work the window still works — it just might end
 * up behind something, and the banner says so rather than implying otherwise.
 */
let onTop = null;
function pinOnTop() {
  if (process.platform !== 'win32') { onTop = false; return; }
  const ps = `
$sig = '[DllImport("user32.dll")] public static extern bool SetWindowPos(IntPtr h, IntPtr a, int x, int y, int cx, int cy, uint f);'
$t = Add-Type -MemberDefinition $sig -Name W -Namespace L -PassThru
$h = (Get-Process -Id ${process.pid}).MainWindowHandle
if ($h -eq 0) { $h = (Get-Process -Id (Get-CimInstance Win32_Process -Filter "ProcessId=${process.pid}").ParentProcessId).MainWindowHandle }
if ($h -ne 0) { [void]$t::SetWindowPos($h, [IntPtr]-1, 0,0,0,0, 0x0043); 'ok' } else { 'no-window' }`;
  execFile('powershell', ['-NoProfile', '-NonInteractive', '-Command', ps], { timeout: 5000 }, (err, out) => {
    onTop = !err && /ok/.test(String(out));
    draw(last);
  });
}

function read() {
  try { return JSON.parse(fs.readFileSync(STATE, 'utf8')); } catch { return null; }
}

const CAPS = ['screen', 'keyboard', 'mouse', 'window'];
const LABEL = { screen: 'Screen', keyboard: 'Keyboard', mouse: 'Mouse', window: 'Windows' };

let last = null;
let stopped = false;

function draw(s) {
  last = s;
  const w = Math.max(46, Math.min(70, process.stdout.columns || 58));
  const line = (t = '') => {
    const plain = String(t).replace(/\x1b\[[0-9;]*m/g, '');
    return '│ ' + t + ' '.repeat(Math.max(0, w - 4 - plain.length)) + ' │';
  };
  const rule = (label) => (label
    ? '┌─ ' + label + ' ' + '─'.repeat(Math.max(0, w - 5 - label.length)) + '┐'
    : '└' + '─'.repeat(w - 2) + '┘');

  const out = [];
  out.push(rule('LAIN DESKTOP CONTROL'));
  if (!s) {
    out.push(line(dim('waiting for LAIN…')));
    out.push(rule());
  } else {
    const live = s.active && !stopped;
    out.push(line(live ? green('● ACTIVE') : (stopped ? red('● CONTROL REVOKED') : dim('○ nothing granted'))));
    out.push(line(''));
    out.push(line(dim('Project  ') + s.project));
    out.push(line(dim('Bridge   ') + (s.bridge.state === 'CONNECTED' ? green(s.bridge.name || 'connected') : yellow(s.bridge.state))));
    out.push(line(dim('Target   ') + (s.target || dim('—'))));
    out.push(line(''));
    for (const cap of CAPS) {
      const st = (s.capabilities || {})[cap] || { granted: false };
      const left = st.granted && st.msLeft != null ? `  ${Math.ceil(st.msLeft / 1000)}s left` : '';
      out.push(line('  ' + LABEL[cap].padEnd(10)
        + (live && st.granted ? green('✓ ALLOWED') + dim(left) : dim('—'))));
    }
    out.push(line(''));
    out.push(line(dim('Recent')));
    const acts = (s.activity || []).slice(-5);
    if (!acts.length) out.push(line(dim('  nothing yet')));
    for (const a of acts) out.push(line('  ' + (a.ok ? green('·') : red('✕')) + ' ' + String(a.text).slice(0, w - 8)));
    out.push(line(''));
    out.push(line(stopped ? dim('  control ended — you can close this window') : bold(red('  [ S ] STOP CONTROL')) + dim('    Esc also stops')));
    if (onTop === false) out.push(line(dim('  (this window could not be pinned on top)')));
    out.push(rule());
  }
  // Redraw in place: clear and home, so it does not scroll away from the STOP.
  process.stdout.write('\x1b[2J\x1b[H' + out.join('\n') + '\n');
}

function stop() {
  if (stopped) return;
  stopped = true;
  try { fs.writeFileSync(REVOKE, String(Date.now()), 'utf8'); } catch { /* LAIN also revokes on exit */ }
  draw(last);
}

if (process.stdin.isTTY) {
  process.stdin.setRawMode(true);
  process.stdin.resume();
  process.stdin.on('data', (b) => {
    const k = b.toString('utf8');
    if (k === 's' || k === 'S' || k === '\x1b' || k === '\x03') stop();
    if (k === 'q' || k === 'Q') process.exit(0);
  });
}

// The window names ITSELF. `start "TITLE"` loses a title containing spaces
// somewhere between Node, cmd and start; OSC and process.title do not.
process.title = 'LAIN DESKTOP CONTROL';
if (process.stdout.isTTY) process.stdout.write('\x1b]0;LAIN DESKTOP CONTROL\x07');
pinOnTop();
draw(read());
setInterval(() => {
  const s = read();
  // LAIN stopped writing, or dropped every grant: control is over either way.
  if (s && !s.active && !stopped) stopped = true;
  draw(s);
}, 500).unref?.();
// Keep the process alive even with the interval unref'd on some platforms.
setInterval(() => {}, 1 << 30);
