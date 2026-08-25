'use strict';

/**
 * THE DASHBOARD COMMAND — starting, stopping and exposing the remote control.
 *
 * Split out of commands.js, which had grown past the god-object guard when
 * autostart and the password gate were added. The seam is the same one the other
 * command files use: commands.js keeps the session, the workspace and the
 * reports; this owns the one command that runs a SERVER, with the three
 * decisions that go with it — whether it binds the network, whether it may act,
 * and whether it comes up by itself.
 *
 * There is still exactly ONE registry. This registers into the same map, at
 * load time, from the bottom of commands.js, and requires nothing back from it.
 *
 * The server itself is dash.js; the page is dashpage.js. This file only decides
 * WHEN and says WHAT HAPPENED.
 */

const config = require('./config');

/**
 * @param {object} api  { define, C } — the registry vocabulary, passed in
 *                      rather than imported back.
 */
function register({ define, C }) {
  /**
   * `/dash` — THE REMOTE-CONTROL DASHBOARD. Not `/rc`, which is readiness.
   *
   * Localhost and read-only by default, behind a password; LAN exposure
   * and the (four, fixed) control actions are each an explicit opt-in that says
   * out loud what it just turned on. See dash.js for why each of those is a
   * default rather than a setting.
   */
  define('/dash', {
    // MACHINERY: about LAIN, not about the work. Goes to the command panel.
    surface: true,
    // READ, not glanced at: an address and a credential you may be copying to
    // a phone. It waits for Esc rather than clearing itself mid-transcription.
    flashMs: 0,
    args: '[on|lan|off|port <n>|actions on|off|autostart on|off|status]',
    desc: 'Remote-control dashboard for a phone or another machine (localhost by default)',
    async run(app, { args }) {
      const dash = require('./dash');
      const w = (s) => app.render.write(s);
      const sub = String(args[0] || (dash.status().running ? 'status' : 'on')).toLowerCase();

      const report = () => {
        const s = dash.status();
        if (!s.running) { w(C.dim('  /dash is not running. /dash on to start it.\n')); return; }
        w('\n' + C.bold('Remote Control') + '\n');
        for (const u of s.urls) w('  ' + C.green(u) + '\n');
        // THE CREDENTIAL, ON ITS OWN LINE, because it is no longer in the URL —
        // the link is safe to send yourself and the secret is not sent with it.
        //
        // WITH A PASSWORD SET, THE STARTUP PASSWORD IS NOT SHOWN. It still works
        // for a script, but printing it here every time would hand out a second
        // way in that bypasses the chosen password, which makes that password
        // decorative.
        //
        // ONE WORD, EITHER WAY. Both lines say "password", because both name the
        // thing a person types. This used to say "startup key" beside "password",
        // which read as two different kinds of credential and left people
        // guessing which one the gate wanted.
        const locked = require('./dashauth').configured(app.cfg);
        if (locked) w('  ' + C.dim('password required') + C.dim(' — /dash password to change it\n'));
        else {
          w('  ' + C.dim('startup password ') + C.bold(s.startupPassword) + '\n');
          w(C.dim('    it changes every restart — /dash password sets one you can remember\n'));
        }
        w(C.dim(`  bound to ${s.host}:${s.port} · pid ${s.pid} · ${s.clients} page load(s)\n`));
        if (s.tookAnotherPort) {
          w('  ' + C.yellow(`port ${s.tookAnotherPort} was already taken by another program`)
            + C.dim(` — this is on ${s.port} instead. Use the URL above, not the usual one.\n`));
        }
        w('  ' + (s.actions ? C.yellow('actions ENABLED') : C.dim('read-only')) + C.dim(' — /dash actions on|off\n'));
        // `!== false`, NOT truthiness — the same rule repl.js starts it by.
        // Reading the raw key made a fresh config (where it is simply absent)
        // report "autostart off" while the dashboard had in fact autostarted
        // thirty seconds earlier. A status line that contradicts the behaviour
        // it describes is worse than no status line.
        w(C.dim(`  autostart ${app.cfg.dashAutostart !== false ? 'ON' : 'off'}`)
          + C.dim(' — /dash autostart on starts it with every session\n'));
        if (s.lan) w('  ' + C.yellow('reachable from your network. Anyone with the password can see this.') + '\n');
        w(C.dim('  The page asks for the password; it is not in the link. Do not paste it anywhere public.\n'));
      };

      if (sub === 'off' || sub === 'stop') {
        const r = dash.stop();
        w(r.ok ? C.green('  ✓ dashboard stopped\n') : C.dim('  it was not running.\n'));
        return;
      }
      if (sub === 'status') { report(); return; }
      if (sub === 'actions') {
        const on = String(args[1] || '').toLowerCase() === 'on';
        const r = dash.setActions(on);
        if (!r.ok) { w(C.dim('  /dash is not running.\n')); return; }
        w(on
          ? '  ' + C.yellow('⚠ actions ENABLED') + C.dim(' — stop, steer, cancel-retry and revoke-desktop can now be triggered remotely.\n')
          : '  ' + C.green('✓ read-only again') + C.dim(' — the dashboard can only look.\n'));
        return;
      }

      // ---- START WITH LAIN, ONCE ASKED ---------------------------------------
      //
      // Persisted rather than defaulted ON. A CLI that begins opening a listening
      // socket for somebody who never asked has changed what the program IS, and
      // "it is only localhost" is a reason it is acceptable when wanted, not a
      // reason to do it uninvited. Asked for once, it is remembered.
      if (sub === 'autostart') {
        const word = String(args[1] || '').toLowerCase();
        if (word !== 'on' && word !== 'off') {
          w(C.dim(`  /dash autostart is ${app.cfg.dashAutostart !== false ? 'ON' : 'OFF'} — /dash autostart on|off\n`));
          return;
        }
        app.cfg.dashAutostart = word === 'on';
        config.save(app.cfg);
        w(word === 'on'
          ? '  ' + C.green('✓ the dashboard will start with LAIN') + C.dim(' — set a password with /dash password so it is the same one every session.\n')
          : '  ' + C.green('✓ autostart off') + C.dim(' — /dash starts it when you want it.\n'));
        // TURNING IT ON MEANS NOW, TOO. Being told "it will start with LAIN" and
        // then finding nothing running until the next session is a promise the
        // command did not keep.
        if (app.cfg.dashAutostart && !dash.status().running) {
          const r0 = await dash.start(app, { lan: Boolean(app.cfg.dashLan) });
          if (r0.ok) report();
          else app.render.notice('error', `could not start the dashboard: ${r0.error}`);
        }
        return;
      }

      // ---- THE PASSWORD ----------------------------------------------------
      //
      // READ FROM A PROMPT, NEVER FROM THE ARGUMENT LINE. `/dash password x`
      // would put the secret into the input history, into the transcript and
      // into Context — three places it must never be — and leave it on screen
      // behind whoever typed it. So the argument form is refused on purpose and
      // the value is asked for through the panel that already exists.
      if (sub === 'password' || sub === 'passwd') {
        const auth = require('./dashauth');
        if (args[1]) {
          w('  ' + C.yellow('not on the command line.') + C.dim(' That would put the password into\n'));
          w(C.dim('  your history, the transcript and the conversation. Run /dash password alone.\n'));
          return;
        }
        if (!app.ui || !app.ui.enabled) {
          w(C.dim('  /dash password asks for the value rather than reading it from the command\n'));
          w(C.dim('  line, and there is nowhere to ask on a pipe. Run it in a terminal.\n'));
          return;
        }
        const typed = await app.ui.ask({
          title: 'DASHBOARD PASSWORD',
          kind: require('./ui/panel').KIND.ASK_USER,
          mode: 'expanded',
          items: [{ label: 'Type a password and press Enter. Esc cancels.', selectable: false }],
          footer: 'hashed with scrypt · never stored, logged or echoed',
          onTyped: (text) => (String(text || '').trim().length >= 4
            ? { close: String(text) }
            : { reject: 'at least 4 characters' }),
        });
        if (typed == null) { w(C.dim('  unchanged.\n')); return; }
        app.cfg.dashPassword = auth.hash(typed);
        config.save(app.cfg);
        // EVERY OPEN PAGE IS LOGGED OUT. Changing the password while the old
        // sessions stayed alive would make the change a suggestion.
        let dropped = 0;
        try { dropped = dash.revokeSessions(); } catch { dropped = 0; }
        w('  ' + C.green('✓ dashboard password set') + C.dim(' — scrypt, salted. The password itself is not stored.\n'));
        if (dropped) w(C.dim(`  ${dropped} open dashboard session(s) logged out.\n`));
        // NOT ECHOED AND NOT CONFIRMED BACK: printing it "so you can check"
        // would undo the whole point of asking for it privately.
        return;
      }

      if (sub === 'port') {
        const n = Number(args[1]);
        if (!n || n < 1 || n > 65535) { w(C.dim('  Usage: /dash port <1-65535>\n')); return; }
        dash.stop();
        const r2 = await dash.start(app, { port: n });
        if (!r2.ok) { app.render.notice('error', `could not start the dashboard: ${r2.error}`); return; }
        w(C.dim('  a fixed port can be shadowed by another program on Windows — if the page looks\n'));
        w(C.dim('  wrong, it is not LAIN. /dash on takes a free port instead.\n'));
        report();
        return;
      }

      const lan = sub === 'lan';
      if (lan) {
        w('  ' + C.yellow('⚠ binding every interface. Anyone who can reach this machine AND has the password can view it.') + '\n');
      }
      const r = await dash.start(app, { lan });
      if (!r.ok) { app.render.notice('error', `could not start the dashboard: ${r.error}`); return; }
      report();
    },
  });

}

module.exports = { register };
