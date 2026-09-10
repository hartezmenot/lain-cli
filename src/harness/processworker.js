'use strict';

// This stable tree root survives the command's shell. Its guardian terminates
// it and its descendants from outside the subtree on completion or owner death.
// It never makes task or verification decisions.
const { spawn } = require('child_process');
// Stay as an OS tree root after the shell exits. The guardian kills this tree
// from outside it, then confirms exit before releasing ownership.
setInterval(() => {}, 60_000);
process.once('message', (spec) => {
  if (!process.connected) return;
  let child;
  const opts = { cwd: spec.cwd, env: spec.env, windowsHide: true, stdio: ['inherit', 'inherit', 'inherit'] };
  const report = (message) => { if (process.connected) process.send(message, () => {}); };
  try {
    child = spec.args ? spawn(spec.command, spec.args, opts)
      : spawn(spec.command, { ...opts, shell: spec.shell || true });
  } catch (e) { report({ error: e.message }); return; }
  if (child.pid && process.connected) process.send({ startedPid: child.pid }, () => {});
  child.once('error', (e) => report({ error: e.message }));
  child.once('exit', (code, signal) => report({ code, signal }));
});
