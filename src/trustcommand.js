'use strict';

/**
 * `/trust` and `/permissions` — what LAIN may touch, and what it was refused.
 *
 * Two commands rather than one because they answer two questions a person asks
 * at different moments: "what is this session allowed to do" (a standing
 * setting) and "what did it just try that I stopped" (a review). Merging them
 * produced a screen that was half configuration and half history, and the thing
 * you came to do was always in the other half.
 *
 * Registered into the ONE command registry from commands.js, like every other
 * command file. Both are `surface: true` — this is machinery, not the work —
 * and neither auto-closes, because both are read rather than glanced at.
 */

const path = require('path');

const config = require('./config');
const trust = require('./trust');
const rejected = require('./rejected');

/**
 * How the filesystem gate is behaving right now, in one word.
 *
 * READ FROM trust.js, NOT COMPUTED HERE. This used to translate the old boolean
 * into its own vocabulary — STRICT / AUTO — while the gate read the boolean
 * directly, so there were two descriptions of one setting and only one of them
 * could name the third state. `/permissions` now shows exactly what the gate
 * enforces because it is the same function.
 */
function modeOf(cfg) {
  return trust.modeOf(cfg || {});
}

/** Set the mode, from any of the words a person might use for it. */
const MODE_WORDS = {
  ask: trust.MODE.ASK, strict: trust.MODE.ASK, prompt: trust.MODE.ASK, confirm: trust.MODE.ASK,
  auto: trust.MODE.AUTO, allow: trust.MODE.AUTO, yes: trust.MODE.AUTO,
  deny: trust.MODE.DENY, denied: trust.MODE.DENY, restricted: trust.MODE.DENY,
  off: trust.MODE.DENY, none: trust.MODE.DENY, no: trust.MODE.DENY,
};

/**
 * Apply a mode and say what it now means. ONE writer for the setting, so
 * `/trust strict` and `/permissions mode ask` cannot record different things.
 */
function setMode(app, word, w, C) {
  const mode = MODE_WORDS[String(word || '').toLowerCase()];
  if (!mode) {
    w(C.dim('  Usage: /permissions mode ask | auto | deny\n'));
    w(C.dim(`    ask   ${trust.MODE_MEANS[trust.MODE.ASK]}\n`));
    w(C.dim(`    auto  ${trust.MODE_MEANS[trust.MODE.AUTO]}\n`));
    w(C.dim(`    deny  ${trust.MODE_MEANS[trust.MODE.DENY]}\n`));
    return false;
  }
  app.cfg.permissionMode = mode;
  // THE OLD BOOLEAN IS REMOVED, not left beside the new field. Two settings
  // that can disagree about what is allowed is the bug this replaces, and a
  // stale `autoOutsideProject` in a config file read by an older LAIN would be
  // exactly that.
  delete app.cfg.autoOutsideProject;
  config.save(app.cfg);
  w('  ' + C.green(`✓ ${mode.toLowerCase()}`) + C.dim(` — ${trust.MODE_MEANS[mode]}\n`));
  if (mode !== trust.MODE.DENY) {
    w(C.dim('    system and credential locations are ALWAYS asked about, whatever the mode.\n'));
  }
  return true;
}

function register({ define, C }) {
  /**
   * `/trust` — the standing decision about this directory.
   */
  define('/trust', {
    surface: true,
    flashMs: 0,
    args: '[yes | read-only | no | list | ask | auto | deny]',
    desc: 'What LAIN may read, write and run in this directory',
    async run(app, { args }) {
      const w = (s) => app.render.write(s);
      const dir = app.session.cwd;
      const sub = String(args[0] || '').toLowerCase();

      if (sub === 'yes' || sub === 'trust') {
        app.cfg.trustedPaths = trust.remember(app.cfg, dir, trust.LEVEL.TRUSTED);
        config.save(app.cfg);
        w('  ' + C.green('✓ trusted') + C.dim(` — LAIN may read, write and run in ${path.basename(dir)}\n`));
        return;
      }
      if (sub === 'read-only' || sub === 'readonly' || sub === 'ro') {
        app.cfg.trustedPaths = trust.remember(app.cfg, dir, trust.LEVEL.READ_ONLY);
        config.save(app.cfg);
        w('  ' + C.green('✓ read only') + C.dim(' — it may look; every write will ask\n'));
        return;
      }
      if (sub === 'no' || sub === 'revoke') {
        app.cfg.trustedPaths = trust.remember(app.cfg, dir, trust.LEVEL.UNTRUSTED);
        config.save(app.cfg);
        w('  ' + C.yellow('✓ untrusted') + C.dim(' — this directory is no longer decided about\n'));
        return;
      }
      // STRICT AND AUTO ARE ABOUT OUTSIDE THE PROJECT, not about this
      // directory. Named here because they are the same subject — what may be
      // touched — and a second command for one boolean is a command too many.
      // `strict` and `auto` are two of the three modes under older names, and
      // they go through the SAME setter as `/permissions mode` so the two
      // commands cannot record different things. `deny` is reachable here too:
      // refusing to accept a word the other command accepts would be a puzzle
      // with no upside.
      if (sub === 'strict' || sub === 'auto' || sub === 'ask' || sub === 'deny') {
        setMode(app, sub, w, C);
        return;
      }

      // ---- THE REPORT ------------------------------------------------------
      const level = trust.levelOf(app.cfg, dir);
      w('\n' + C.bold('Trust') + '\n');
      w('  ' + C.dim('directory  ') + dir + '\n');
      w('  ' + C.dim('level      ')
        + (level === trust.LEVEL.TRUSTED ? C.green(level)
          : level === trust.LEVEL.READ_ONLY ? C.yellow(level) : C.red(level)) + '\n');
      w('  ' + C.dim('outside    ') + modeOf(app.cfg)
        + C.dim(' — ' + trust.MODE_MEANS[modeOf(app.cfg)]) + '\n');
      const list = (app.cfg.trustedPaths || []);
      if (list.length) {
        w('\n  ' + C.dim('remembered\n'));
        for (const e of list.slice(-8)) {
          w('    ' + (e.level === trust.LEVEL.TRUSTED ? C.green('rw') : C.yellow('ro')) + '  ' + e.path + '\n');
        }
      }
      w(C.dim('\n  /trust yes · read-only · no    ·    /permissions mode ask|auto|deny\n'));
    },
  });

  /**
   * `/permissions` — what was refused, and the chance to change your mind.
   */
  define('/permissions', {
    surface: true,
    flashMs: 0,
    args: '[mode ask|auto|deny | allow <n> | clear]',
    desc: 'How LAIN asks before touching things, and what it was refused',
    async run(app, { args }) {
      const w = (s) => app.render.write(s);
      const list = rejected.all(app);
      const sub = String(args[0] || '').toLowerCase();

      // ---- THE MODE, WHICH IS THE SETTING THIS COMMAND WAS MISSING --------
      //
      // There was no way to say "never ask me, just refuse it". On an
      // unattended run the gate would put a prompt on a screen nobody is
      // looking at and wait for an answer that was never coming.
      if (sub === 'mode') { setMode(app, args[1], w, C); return; }
      if (MODE_WORDS[sub]) { setMode(app, sub, w, C); return; }

      if (sub === 'clear') {
        w(C.dim(`  cleared ${rejected.clear(app)} refusal(s)\n`));
        return;
      }
      if (sub === 'allow') {
        const n = Number(args[1]);
        const entry = list[n - 1];
        if (!entry) { w(C.dim(`  no refusal numbered ${args[1] || '?'} — /permissions to see the list\n`)); return; }
        const r = rejected.allow(app, entry.id);
        if (!r.ok) { w(C.dim(`  ${r.error}\n`)); return; }
        w('  ' + C.green('✓ allowed') + C.dim(` — ${r.dir} is now trusted. Ask the model to try again.\n`));
        return;
      }

      const mode = modeOf(app.cfg);
      w('\n' + C.bold('Permissions') + '\n');
      w('  ' + C.dim('mode       ')
        + (mode === trust.MODE.DENY ? C.yellow(mode) : C.green(mode))
        + C.dim(` — ${trust.MODE_MEANS[mode]}\n`));
      w('  ' + C.dim('directory  ') + trust.levelOf(app.cfg, app.session.cwd) + '\n');
      w(C.dim('  /permissions mode ask|auto|deny · /trust for this directory\n'));
      if (!list.length) {
        w(C.dim('\n  nothing has been refused this session.\n'));
        return;
      }
      w('\n');
      list.forEach((e, i) => {
        const mark = e.allowed ? C.green('✓') : C.yellow('✗');
        const times = e.count > 1 ? C.dim(` ×${e.count}`) : '';
        w(`  ${mark} ${String(i + 1).padStart(2)}  ${e.tool}${times}\n`);
        w(C.dim(`        ${e.target}\n`));
        w(C.dim(`        ${e.why}\n`));
      });
      w(C.dim('\n  /permissions allow <n> to allow one · /permissions clear to forget them\n'));
    },
  });
}

module.exports = { register, modeOf, setMode, MODE_WORDS };
