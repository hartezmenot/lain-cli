'use strict';

/**
 * THE AS-YOU-TYPE MENUS — `/` for commands, `@` for files.
 *
 * Split out of ui/index.js, which had grown past the god-object guard. This is
 * the right owner rather than a convenient one: a menu is a VIEW OF THE INPUT
 * LINE, and everything here is about what the line currently asks for. The UI
 * object keeps the panel, the screen and the keyboard; this decides what to
 * OFFER while a line is being typed, and how the offer is accepted.
 *
 * Nothing here classifies the text as a task or a command — `looksLikeCommand`
 * still decides that at submit time. Accepting a completion EDITS the line and
 * stops there; a menu never rewrites what it was not asked to complete.
 *
 * ENTER IS THE EXCEPTION, and it is not optional. While a menu is open the
 * reader stops submitting (input.js `_consume` → `enterGoesToUI`), so Enter is
 * only ever sent from here. Every Enter must therefore end in the line going
 * SOMEWHERE: the highlighted command when there is one, and the line as typed
 * when there is not. A menu that swallows Enter is a menu that eats the input.
 */

const panelMod = require('./panel');

/** The `@token` being typed at the end of the line, or null. */
function atToken(text) {
  const m = /(?:^|\s)@([^\s]*)$/.exec(String(text || ''));
  return m ? m[1] : null;
}

/**
 * Re-evaluate the menus for the line as it now stands. Called on every edit.
 *
 * A menu opens when the line asks for one, updates as the line narrows, and
 * closes when it no longer applies.
 */
function updateMenus(ui, text, { pasted = false } = {}) {
  if (!ui.enabled) return;
  // A MENU IS AN OFFER MADE TO SOMEONE WHO IS TYPING.
  //
  // Pasted text is not typing, and a multi-line buffer is content by
  // construction — the same rule `looksLikeCommand` applies at submit time,
  // applied here so the two can never disagree. Without this, pasting a note
  // that happens to end in `@src/` opened the file picker over the user's text,
  // and pasting the single line `/models` opened the command palette.
  //
  // This does not disable anything for a real keystroke: type `@src/` after a
  // paste and the completion still opens, because that edit IS typed.
  if (pasted) return;
  if (String(text || '').includes('\n')) { closeMenu(ui); return; }
  // THE MODEL BROWSER FILTERS AS YOU TYPE.
  //
  // With a real router the list is ~934 entries, and arrowing to one is not
  // browsing, it is scrolling. Typing narrows it. This is confined to the TOP
  // frame of the browser: once you have drilled into a model's routes the
  // keystrokes belong to that list, not to a search you can no longer see.
  //
  // Purely local — the catalog is already in memory and no request is made.
  if (ui.panel.visible && ui.panel.kind === panelMod.KIND.MODEL_SELECTION) {
    if (ui._modelFilter) ui._modelFilter(String(text || ''));
    return;
  }
  if (ui.panel.visible && !ui.panel.isCompletion) return;   // other modals win
  const line = String(text || '');
  const commands = require('../commands');

  // `/` at the START of the line only. A slash mid-sentence is prose; a pasted
  // one was refused above.
  if (/^\/\S*$/.test(line)) {
    showMenu(ui, panelMod.commandPaletteAdapter({
      // `offered()` rather than the raw registry: a compatibility alias still
      // runs when typed and is never proposed. See commands.js `define`.
      commands: commands.offered(),
      filter: line,
    }));
    return;
  }

  const at = atToken(line);
  if (at !== null) {
    const entries = require('../project').completePath(ui.app.session.cwd, at);
    showMenu(ui, panelMod.fileCompletionAdapter({ entries, filter: at }));
    return;
  }

  closeMenu(ui);
}

/**
 * Keys that belong to an open completion menu. Returns true when consumed.
 */
function completionKey(ui, key) {
  if (!ui.enabled || !ui.panel.isCompletion) return false;
  if (key !== 'tab' && key !== 'right' && key !== 'enter') return false;
  const app = ui.app;
  const item = ui.panel.current;
  // ---- ENTER WITH NOTHING HIGHLIGHTED MUST STILL SUBMIT THE LINE ----------
  //
  // This closed the menu and CONSUMED the key, so a `/` line the palette had
  // no entry for could not be RUN AT ALL: the menu vanished, the text stayed
  // on the input row, and nothing happened. Pressing Enter again did the same.
  //
  // The reader is why silence was total. input.js `_consume` asks
  // `enterGoesToUI()` and, while a menu is open, emits Enter as a KEY instead
  // of submitting — so the line is never sent unless something here sends it.
  // Falling through is not enough; nothing downstream submits a NON-EMPTY line.
  //
  // It stayed invisible until a command became HIDDEN. `offered()` fills this
  // palette and it excludes compatibility aliases, so `/models` — which
  // commands.js `define` promises "still runs when typed" — produced an EMPTY
  // palette whose Enter was swallowed. The promise held through a pipe and
  // broke in the TUI, which is the worst way for it to be wrong.
  //
  // Tab and Right still belong to the menu: there is nothing to complete, so
  // they are consumed and do nothing. ENTER is not a completion key here — it
  // is the SUBMIT key — so the line goes, reaching either its command or
  // `Unknown command`. Being told is the point; silence was the only wrong
  // answer.
  if (!item) {
    if (key !== 'enter') return true;
    closeMenu(ui);
    app.input.submitLine();
    return true;
  }

  if (ui.panel.kind === panelMod.KIND.COMMAND_PALETTE) {
    closeMenu(ui);
    app.input.setLine(item.command + ' ');
    if (key === 'enter') {
      // WHILE A TURN IS RUNNING, run it now instead of queueing.
      //
      // `submitLine()` emits an input event, and the REPL loop sits inside
      // `await handle(...)` for the whole of a turn — so a command chosen from
      // the palette mid-task waited for the very work the user opened the
      // palette to look away from, and appeared to do nothing. That is the
      // "I can't use the slash menu while it's working" problem.
      //
      // WHEN NOTHING IS RUNNING it must go through the queue exactly as before.
      // Bypassing unconditionally also jumped it ahead of input that was ALREADY
      // QUEUED — piped stdin is consumed in one pass, so a trailing `/exit` ran
      // before the task typed above it and the session ended having done no
      // work. Order is only safe to break when there is nothing left in front.
      const commands = require('../commands');
      const turnActive = Boolean(app.abort && !app.abort.signal.aborted);
      if (!turnActive) { app.input.submitLine(); return true; }
      app.input.setLine('');
      ui.setInput('');
      const line = item.command;
      Promise.resolve(commands.run(app, line)).catch((e) => {
        app.render.notice('error', `${line}: ${e && e.message}`);
      });
    }
    return true;
  }

  // FILE_COMPLETION: splice the chosen path over the `@token` being typed.
  const next = app.input.line.replace(/@[^\s]*$/, '@' + item.value);
  app.input.setLine(next);
  // A directory re-lists one level deeper so a path is walked segment by
  // segment; a file is the end of the road and the menu gets out of the way.
  if (item.entry && item.entry.isDir) updateMenus(ui, next);
  else closeMenu(ui);
  return true;
}

/**
 * Open or update the transient completion menu.
 *
 * `replace` rather than `open` while it is already showing: reopening would
 * discard the panel's promise on every keystroke. Returns nothing — the menu
 * resolves nothing; it edits the input line and that is all.
 */
function showMenu(ui, adapter) {
  if (!ui.enabled) return;
  if (ui.panel.visible && ui.panel.isCompletion) ui.panel.replace(adapter);
  else if (!ui.panel.visible) ui.panel.open(adapter);
  else return;                       // a modal panel is open; leave it alone
  ui.refresh();
}

/** Close the completion menu, if that is what is open. Never closes a modal. */
function closeMenu(ui) {
  if (!ui.panel.visible || !ui.panel.isCompletion) return false;
  ui.panel.close(null);
  ui.refresh();
  return true;
}

module.exports = { atToken, updateMenus, completionKey, showMenu, closeMenu };
