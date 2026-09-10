'use strict';

/**
 * UNINSTALL — remove exactly what was installed, and nothing a person owns.
 *
 * ------------------------------------------------------------------------
 * WHAT IT REMOVES:
 *
 *   the launcher files this installer wrote          (by name, in the bin dir)
 *   the PATH entry this installer added              (by exact path match)
 *
 * WHAT IT NEVER REMOVES:
 *
 *   the checkout                — not ours to delete
 *   `~/.lain-v2/config.json`    — the person's credentials and connections
 *   `~/.lain-v2/sessions/`      — their work
 *   `<project>/.lain/`          — the project's own evidence and task records
 *
 * An uninstaller that takes the sessions with it is a data-loss bug wearing a
 * feature's clothes. Removing a command from PATH and destroying somebody's
 * history are different requests, and only the first one was made.
 *
 * The PATH entry is removed by MATCHING THE DIRECTORY, never by rewriting the
 * variable — see pathenv.remove. Every other entry comes back byte-identical.
 */

const fs = require('fs');
const path = require('path');

const detect = require('./detect');
const pathenv = require('./pathenv');

function uninstall(opts = {}) {
  const plat = detect.platform();
  const dir = opts.dir || detect.binDir();
  const out = { ok: true, removed: [], steps: [], kept: [], warnings: [] };

  // ---- THE LAUNCHERS, BY NAME --------------------------------------------
  //
  // Only the names this installer generates. A `rm -rf` of the directory would
  // take anything else a person had put there, and the directory is inside
  // their home.
  for (const name of Object.keys(plat.shims('x'))) {
    const file = path.join(dir, name);
    try {
      if (fs.statSync(file).isFile()) {
        fs.unlinkSync(file);
        out.removed.push(file);
      }
    } catch { /* it was not there, which is the desired end state anyway */ }
  }
  out.steps.push({
    ok: true,
    text: out.removed.length ? `removed ${out.removed.length} launcher(s) from ${dir}` : `no launchers in ${dir}`,
  });

  // ---- THE PATH ENTRY ----------------------------------------------------
  if (opts.skipPath) {
    out.steps.push({ ok: true, text: 'PATH: left alone as asked' });
  } else {
    const env = opts.env || plat.env;
    const r = pathenv.remove(env, dir);
    out.steps.push({ ok: r.ok, text: `PATH: ${r.why}` });
    if (!r.ok) { out.ok = false; out.warnings.push(`PATH was not changed: ${r.why}`); }
  }

  // ---- AND WHAT WAS DELIBERATELY LEFT ------------------------------------
  //
  // Named out loud. Somebody uninstalling wants to know what is still on their
  // disk, and finding out later feels like the tool lied.
  out.kept.push(`${detect.home()}${path.sep}config.json (your connections)`);
  out.kept.push(`${detect.home()}${path.sep}sessions (your saved sessions)`);
  out.kept.push(`${detect.runtimeRoot()} (this checkout)`);
  return out;
}

function render(result) {
  const lines = ['LAIN Harness — uninstall', ''];
  for (const s of result.steps) lines.push(`  ${s.ok ? '✓' : '✗'} ${s.text}`);
  for (const w of result.warnings) lines.push(`  ! ${w}`);
  lines.push('');
  lines.push('  Left in place, deliberately:');
  for (const k of result.kept) lines.push(`    ${k}`);
  return lines.join('\n');
}

module.exports = { uninstall, render };

if (require.main === module) {
  const argv = process.argv.slice(2);
  const opts = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--dir') opts.dir = argv[++i];
    else if (argv[i] === '--no-path') opts.skipPath = true;
  }
  const r = uninstall(opts);
  process.stdout.write(`${render(r)}\n`);
  process.exitCode = r.ok ? 0 : 1;
}
