'use strict';

/**
 * `/source` — WHICH MODEL ANSWERS A CHAT TURN.
 *
 * ------------------------------------------------------------------------
 * THIS IS A DIAGNOSTIC SURFACE, NOT THE PRODUCT.
 *
 * The real picker is the Harness application's, and it is not this pass's to
 * build. What is here is the smallest thing that makes the backend provable by
 * hand: list the sources, connect one, see what models the logged-in account
 * actually has, choose one, and see where the next chat turn would go.
 *
 * It follows the conventions the other machinery commands already follow —
 * `surface: true`, so it draws on the command surface rather than into the
 * conversation, and it says NOT CONFIGURED out loud rather than guessing.
 *
 * ------------------------------------------------------------------------
 * IT REPLACES `/external`, AND IT IS NOT A RENAME OF IT.
 *
 * `/external` was a DRAFT-AND-DISPATCH command: it composed a packet, showed it,
 * asked, sent it once, printed the answer and handed it back as advice. Every
 * one of those steps was that command's own machinery, and a person who wanted
 * a second opinion had to remember a command to get one.
 *
 * A chat source is not a command. Once ChatGPT.com is the selected source, the
 * next ordinary sentence goes to it and the answer lands in the same session
 * history as everything else. There is nothing to type but the question, which
 * is why the useful half of `/external` comes back as a SELECTION rather than as
 * a verb.
 */

const registry = require('./modelsource/registry');
const webprofile = require('./modelsource/webprofile');
const { CONNECTION, MODEL_STATE, KIND } = require('./modelsource/contract');

/** How many models are listed before the tail is summarised. */
const LIST = 40;

/** One word per connection state, in the vocabulary the rest of the CLI uses. */
function paint(C, state) {
  if (state === CONNECTION.READY) return C.green(state);
  if (state === CONNECTION.AUTH_REQUIRED) return C.yellow(state);
  if (state === CONNECTION.RATE_LIMITED) return C.yellow(state);
  if (state === CONNECTION.FAILED || state === CONNECTION.UNAVAILABLE) return C.yellow(state);
  return C.dim(state);
}

function register({ define, C }) {
  define('/source', {
    // MACHINERY: about LAIN, not about the work. Goes to the command surface.
    surface: true,
    args: '[ lain | chatgpt | gemini | models [refresh] | use <model> | connect | disconnect | forget | check ]',
    desc: 'Which model answers a chat turn — LAIN, ChatGPT.com or Gemini.google.com',
    async run(app, { args = [], rest = '' } = {}) {
      const w = (x) => app.render.write(x);
      const sub = String(args[0] || '').toLowerCase();

      // ---- WHAT IS SELECTED, AND WHAT EACH SOURCE WOULD COST ------------
      if (!sub || sub === 'status') {
        const view = await registry.overview(app);
        w('\n' + C.bold('Chat source') + C.dim('  — who answers a chat turn; coding is always LAIN\n\n'));
        for (const s of view.sources) {
          const mark = s.chosen ? C.green('●') : C.dim('○');
          const model = s.selected ? C.bold(s.selected) : C.dim('no model chosen');
          w(`  ${mark} ${String(s.label).padEnd(22)} ${paint(C, s.state)}  ${model}\n`);
          if (s.why) w(C.dim(`      ${s.why}\n`));
        }
        w(C.dim('\n  /source chatgpt   then  /source models   then  /source use <model>\n'));
        // WHERE THE NEXT TURN WOULD GO, said plainly. It is the one thing a
        // person actually wants to know and the one thing that is not obvious
        // from the list — a coding sentence goes to LAIN whatever is selected.
        w(C.dim('  A coding request always runs on LAIN\'s runtime, whatever is selected here.\n'));
        return;
      }

      const ALIAS = { lain: registry.SOURCE.LAIN, chatgpt: registry.SOURCE.CHATGPT_WEB, gemini: registry.SOURCE.GEMINI_WEB };
      if (ALIAS[sub]) {
        const r = registry.selectSource(app, ALIAS[sub]);
        if (!r.ok) { w('  ' + C.yellow(r.why) + '\n'); return; }
        w('  ' + C.green('✓ chat source: ') + C.bold(registry.LABEL[r.source]) + '\n');
        if (r.model) w(C.dim(`    model ${r.model} — /source models to change it\n`));
        else if (ALIAS[sub] !== registry.SOURCE.LAIN) w(C.dim('    no model chosen yet — /source models\n'));
        try { app.session.save(); } catch { /* the selection still holds for this run */ }
        return;
      }

      const src = registry.selected(app);

      if (sub === 'connect') {
        w(C.dim(`  opening ${src.label}…\n`));
        const st = await src.connect();
        w('  ' + paint(C, st.state) + (st.why ? C.dim(`  ${st.why}`) : '') + '\n');
        if (st.state === CONNECTION.AUTH_REQUIRED) {
          // AUTHENTICATION IS THE PERSON'S. LAIN opened the window; it does not
          // type a password, answer an MFA prompt or solve a CAPTCHA, and it
          // never will. See webmodel.js.
          w(C.dim('    Log in in the browser window LAIN opened, then /source models.\n'));
        }
        return;
      }

      if (sub === 'disconnect') {
        const st = await src.disconnect();
        w('  ' + C.dim(`${src.label}: ${st.state} — your saved login is untouched (/source forget removes it)`) + '\n');
        return;
      }

      if (sub === 'forget') {
        if (src.kind !== KIND.WEB) { w(C.dim('  only a website source has a saved login.\n')); return; }
        await src.disconnect();
        const r = webprofile.forget(src.id);
        w('  ' + (r.ok ? C.green(`✓ removed the saved login for ${src.label}`) : C.yellow(r.why)) + '\n');
        return;
      }

      if (sub === 'models') {
        const refresh = String(args[1] || '').toLowerCase() === 'refresh';
        w(C.dim(`  reading what ${src.label} offers this account…\n`));
        const inv = await src.discoverModels({ refresh });
        if (!inv.ok) {
          w('  ' + C.yellow(inv.why) + '\n');
          if (inv.authRequired) w(C.dim('    /source connect, log in, then try again.\n'));
          return;
        }
        w('\n' + C.bold(`${src.label} models`) + C.dim(inv.cached ? '  — cached; /source models refresh to re-read\n\n' : '\n\n'));
        const chosen = src.selectedModel();
        for (const m of inv.models.slice(0, LIST)) {
          const mark = m.id === chosen ? C.green('●') : C.dim('○');
          const state = m.state === MODEL_STATE.AVAILABLE ? '' : C.dim(`  ${m.state}`);
          w(`  ${mark} ${C.bold(m.id)}${m.label && m.label !== m.id ? C.dim(`  ${m.label}`) : ''}${state}\n`);
        }
        if (inv.models.length > LIST) w(C.dim(`  … ${inv.models.length - LIST} more\n`));
        w(C.dim('\n  /source use <model>\n'));
        return;
      }

      if (sub === 'use') {
        const want = String(rest || '').replace(/^use\s+/i, '').trim();
        if (!want) { w(C.dim('  Usage: /source use <model>   (/source models to see the list)\n')); return; }
        const r = await src.selectModel(want);
        if (!r.ok) { w('  ' + C.yellow(r.why) + '\n'); return; }
        w('  ' + C.green('✓ ') + C.bold(registry.LABEL[src.id] || src.id) + C.dim(' · ') + C.bold(r.modelId) + '\n');
        try { app.session.save(); } catch { /* the selection still holds for this run */ }
        return;
      }

      if (sub === 'check') {
        // LIVE CERTIFICATION, run deliberately and never by a test tier. See
        // modelsource/check.js for what it proves and what it costs.
        //
        // `fixture` runs the same five steps against a fake site, which is how
        // a red live run is told apart from a broken check.
        const checkMod = require('./modelsource/check');
        const which = String(args[1] || '').toLowerCase();
        const lines = which === 'fixture' || which === 'self'
          ? await checkMod.selfTest(app)
          : await checkMod.run(app, src, { rest: String(args[1] || '') });
        for (const l of lines) w('  ' + l + '\n');
        return;
      }

      w(C.dim('  /source [lain | chatgpt | gemini | models | use <model> | connect | disconnect | forget | check]\n'));
    },
  });
}

module.exports = { register };
