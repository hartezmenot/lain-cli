'use strict';

/**
 * `/app` — OPEN THE LAIN HARNESS APPLICATION.
 *
 * ------------------------------------------------------------------------
 * ONE PRODUCT, TWO SURFACES, ONE PROCESS.
 *
 * This does not start a second LAIN. It serves the graphical surface over the
 * `App` that is already running in this terminal — the same session, the same
 * conversation, the same task, the same Harness. Typing here and typing there
 * append to one history because there is one.
 *
 * That is also why there is no "open a project" in the application: `/resume`
 * and the working directory decide which session is current, and a second way
 * to decide it would be a second answer to the question.
 *
 * ------------------------------------------------------------------------
 * IT PRINTS THE PASSWORD INTO THE TERMINAL, WHICH IS THE POINT.
 *
 * The credential is shown to whoever can already see this terminal, and the URL
 * carries none — so the link is safe to hand around and the password is not.
 * Same rule, same machinery, as `/dash`.
 */

function register({ define, C }) {
  define('/app', {
    // MACHINERY: about LAIN, not about the work. Goes to the command surface.
    surface: true,
    // Read whenever, including mid-turn: watching a running turn in the
    // application is the main reason to open it.
    flashMs: 0,
    args: '[stop|status]',
    desc: 'Open the LAIN Harness application — the graphical surface for this session',
    async run(app, { args = [] } = {}) {
      const w = (s) => app.render.write(s);
      const server = require('./harnessapp/server');
      const sub = String(args[0] || '').toLowerCase();

      if (sub === 'stop') {
        // THE WINDOW GOES WITH THE SERVER. Leaving a window open over a dead
        // listener gives a person a Harness that shows nothing and explains
        // itself in a place they are not looking.
        require('./harnessapp/desktop').close();
        const r = server.stop();
        w(C.dim(r.stopped ? '  Harness application stopped.\n' : '  It was not running.\n'));
        return;
      }
      if (sub === 'status') {
        const s = server.status();
        if (!s.running) { w(C.dim('  not running — /app to open it\n')); return; }
        w('  ' + C.green('running') + C.dim('  ' + s.url) + '\n');
        // WHICH SURFACE IS ACTUALLY UP. "running" describes the listener; a
        // person asking `/app status` wants to know whether the WINDOW is there.
        const d = require('./harnessapp/desktop').status();
        w(C.dim(d.open ? `  window   Chromium ${d.version || ''}\n` : '  window   closed — /app reopens it\n'));
        return;
      }

      const r = await server.start(app);
      if (!r.ok) { w('  ' + C.yellow(r.why) + '\n'); return; }
      if (r.already) {
        w('\n' + C.bold('  LAIN Harness') + C.dim('  already open\n'));
        w(C.dim('  ') + C.cyan(r.url) + '\n');
        // A SECOND `/app` MUST OPEN A SECOND TIME. `start` hands back a fresh
        // launch token for exactly this — somebody who closed the tab and typed
        // `/app` again is asking for the window, not for the URL.
        const again = await require('./harnessapp/desktop').open(app, r.launchUrl || r.url);
        if (!again.ok) w('  ' + C.yellow('Could not open the window: ') + C.dim(again.why) + '\n');
        return;
      }
      w('\n' + C.bold('  LAIN Harness') + C.dim('  — the graphical surface for this session\n\n'));
      w(C.dim('  ') + C.cyan(r.url) + '\n\n');
      // ---- IT OPENS ITSELF, AND NOTHING IS PASTED ------------------------
      //
      // The password is not printed any more. `/app` opens the page in the
      // person's own browser carrying a ONE-TIME launch token, which the server
      // exchanges for a session while serving the document — see
      // harnessapp/server.js. There is no step at which a human retypes a hex
      // string that LAIN just printed and LAIN is about to check, which is the
      // step that was failing.
      //
      // The startup password still EXISTS, for somebody who opens the port by
      // hand or in a second browser; it is simply no longer the normal path.
      // ---- AN APPLICATION WINDOW, NOT A TAB ------------------------------
      //
      // `desktop.open` launches the Harness-owned Chromium in `--app=` mode:
      // no tab strip, no address bar, its own taskbar entry. It falls back to
      // the default browser and SAYS SO rather than failing, because a Harness
      // in a tab beats no Harness.
      const opened = await require('./harnessapp/desktop').open(app, r.launchUrl || r.url);
      if (opened.ok) {
        w(C.dim(opened.mode === 'window'
          ? '  Opened as an application window. It drives THIS session.\n'
          : `  Opened in your browser — ${opened.why}\n`));
      } else {
        // FAILURE IS SAID PLAINLY, with the thing the person needs next.
        // "Errors not clearly printed" was one of the reported defects.
        w('  ' + C.yellow('Could not open a browser: ') + C.dim(opened.why) + '\n');
        w(C.dim('  Open the link above yourself — it carries a one-time key.\n'));
      }
      w(C.dim('  /app stop closes it.\n'));
    },
  });
}

module.exports = { register };
