'use strict';

/**
 * THE SOURCE WORKSPACE — the tree, the tabs, the editor.
 *
 * ------------------------------------------------------------------------
 * NO BACKTICKS ANYWHERE BELOW, COMMENTS INCLUDED. Everything this file emits
 * lives inside one template literal, and a stray backtick ends it — producing
 * a page that composes perfectly and does not parse. That has now cost two
 * passes; there is a test (`the page is one self-contained document with valid
 * script`) that runs `new Function` over the result and catches it.
 *
 * ------------------------------------------------------------------------
 * THE HIGHLIGHTER IS DELIBERATELY SMALL.
 *
 * A real grammar-based highlighter is a dependency and a build step, and this
 * project has neither. What is here is a tokeniser that handles the four things
 * that actually make code readable at a glance — comments, strings, numbers,
 * keywords — and stops. It is honest about what it is: it will mis-colour a
 * regex containing a quote, and it will not pretend to parse TypeScript
 * generics.
 *
 * It is applied ONE LINE AT A TIME, over escaped text, and it never inserts
 * anything but its own spans. That is what keeps it safe: the file body is
 * escaped before the highlighter ever sees it, so nothing in a source file can
 * become markup.
 *
 * ------------------------------------------------------------------------
 * THE EDITOR IS A TEXTAREA UNDER A HIGHLIGHTED LAYER.
 *
 * The textarea is transparent and holds the real text, selection and caret; a
 * `<pre>` behind it, scrolled in lockstep, carries the colour. This is the
 * oldest trick for this and it is the right one here: the browser keeps
 * ownership of editing, IME, undo, spellcheck-off, accessibility and mobile
 * keyboards, and none of that has to be reimplemented. A contenteditable would
 * hand all of it back to us.
 */

/** The Source Workspace's own styles. */
const CSS = `
.src{display:grid;grid-template-columns:230px 1fr;min-height:0;border-left:1px solid var(--line)}
.srcTree{border-right:1px solid var(--line);overflow:auto;padding:8px 0;font-size:12.5px}
.srcRow{display:flex;align-items:center;gap:6px;padding:3px 10px;cursor:pointer;white-space:nowrap;color:var(--dim)}
.srcRow:hover{background:#12161c;color:var(--ink)}
.srcRow.dir{color:var(--ink)}
.srcRow .tw{width:10px;color:var(--faint);flex:none}
.srcRow .nm{overflow:hidden;text-overflow:ellipsis}
.srcRow .ch{width:6px;height:6px;border-radius:50%;background:var(--warn);flex:none;margin-left:auto}
.srcPane{display:grid;grid-template-rows:auto auto 1fr;min-height:0}
.srcTabs{display:flex;gap:2px;padding:6px 8px 0;overflow-x:auto;border-bottom:1px solid var(--line)}
.srcTab{display:flex;align-items:center;gap:7px;padding:5px 10px;border-radius:var(--radius) var(--radius) 0 0;
        color:var(--dim);font-size:12.5px;white-space:nowrap;border:1px solid transparent;border-bottom:0}
.srcTab[aria-selected=true]{background:var(--grey);color:var(--ink)}
.srcTab .dot{width:6px;height:6px;border-radius:50%;background:var(--warn)}
.srcTab .x{color:var(--faint);font-size:14px;line-height:1}
.srcTab .x:hover{color:var(--bad)}
.srcBar{display:flex;align-items:center;gap:10px;padding:6px 12px;border-bottom:1px solid var(--line);font-size:12px;color:var(--faint)}
.srcBar input{background:var(--grey);border-radius:var(--radius);padding:3px 8px;width:200px;flex:none}
.srcBar .sp{flex:1}
.srcBar button{padding:3px 10px;border-radius:var(--radius);border:1px solid var(--line);color:var(--dim);font-size:12px}
.srcBar button:hover{color:var(--ink);border-color:#2b3542}
.srcBar button.act{background:var(--accent);color:#04121d;border-color:var(--accent);font-weight:600}
.srcEdit{position:relative;overflow:auto;background:var(--bg);min-height:0}
.srcEdit .wrap{position:relative;min-height:100%;display:flex}
.srcGut{flex:none;padding:10px 8px 10px 12px;text-align:right;color:var(--faint);
        font:12.5px/1.55 var(--mono);user-select:none;background:var(--bg);position:sticky;left:0;z-index:2}
.srcGut div.hit{color:var(--accent)}
.srcCode{position:relative;flex:1;min-width:0}
.srcCode pre,.srcCode textarea{margin:0;padding:10px 12px;font:12.5px/1.55 var(--mono);
        white-space:pre;tab-size:2;border:0;overflow:visible}
.srcCode pre{pointer-events:none;color:var(--ink)}
.srcCode textarea{position:absolute;inset:0;color:transparent;background:transparent;caret-color:var(--accent);
        resize:none;width:100%;height:100%;outline:0}
.srcCode textarea::selection{background:#2a4a63;color:transparent}
.srcCode .ln{display:block}
.srcCode .ln.hit{background:#182430}
.tk-c{color:#5b6675;font-style:italic}
.tk-s{color:#9ad39a}
.tk-n{color:#d9a05b}
.tk-k{color:#7cb6ff}
.tk-t{color:#c99ad9}
.srcEmpty{padding:40px 22px;color:var(--faint);font-size:13px;line-height:1.7}
.srcNote{padding:8px 12px;font-size:12px;color:var(--warn);border-bottom:1px solid var(--line)}
.srcNote.bad{color:var(--bad)}
.srcNote button{margin-left:10px;color:var(--accent);text-decoration:underline}
.srcFind{position:absolute;top:8px;right:16px;z-index:5;background:var(--panel);border:1px solid var(--line);
         border-radius:var(--radius);padding:6px 8px;display:flex;gap:8px;align-items:center;font-size:12px}
.srcFind input{width:160px;background:var(--grey);border-radius:3px;padding:2px 6px}
.quick{position:fixed;inset:0;background:#0008;z-index:40;display:flex;align-items:flex-start;justify-content:center;padding-top:12vh}
.quick .box{width:min(560px,90vw);background:var(--panel);border:1px solid var(--line);border-radius:var(--radius);overflow:hidden}
.quick input{padding:11px 14px;font-size:14px;border-bottom:1px solid var(--line)}
.quick .hits{max-height:50vh;overflow:auto}
.quick .hit{padding:7px 14px;font-size:12.5px;color:var(--dim);cursor:pointer;font-family:var(--mono)}
.quick .hit:hover,.quick .hit[aria-selected=true]{background:var(--grey);color:var(--ink)}
`;

/** The markup. Sits beside the Workshop as the third column. */
const HTML = `
<section class="src" id="srcPanel" hidden>
  <div class="srcTree" id="srcTree"></div>
  <div class="srcPane">
    <div class="srcTabs" id="srcTabs"></div>
    <div class="srcBar">
      <span id="srcPath">no file open</span>
      <span class="sp"></span>
      <span id="srcLang"></span>
      <button id="srcFindBtn">Find</button>
      <button id="srcSave" class="act">Save</button>
    </div>
    <div class="srcEdit" id="srcEdit">
      <div class="srcNote" id="srcNote" hidden></div>
      <div class="wrap">
        <div class="srcGut" id="srcGut"></div>
        <div class="srcCode" id="srcCode">
          <pre id="srcHi"></pre>
          <textarea id="srcText" spellcheck="false" autocomplete="off" autocapitalize="off" wrap="off"></textarea>
        </div>
      </div>
      <div class="srcEmpty" id="srcEmpty">
        Open a file from the tree, or press Ctrl+P.
      </div>
    </div>
  </div>
</section>
<div class="quick" id="quick" hidden>
  <div class="box">
    <input id="quickQ" placeholder="Open file..." autocomplete="off">
    <div class="hits" id="quickHits"></div>
  </div>
</div>
`;

/**
 * THE BEHAVIOUR.
 *
 * `api`, `notice` and `poll` are handed in by pagescript.js so there is exactly
 * one HTTP client, one notice surface and one poll loop in the page.
 */
function js() {
  return `
window.LAIN = window.LAIN || {};
window.LAIN.source = (function () {
  'use strict';
  var api = null, notice = null, poll = null;
  var $ = function (id) { return document.getElementById(id); };

  var st = {
    open: [],          // [{path, body, saved, mtimeMs, language, dirty}]
    active: -1,
    expanded: {},      // path -> true
    tree: {},          // path -> entries
    hits: [],          // find/patch results, as line numbers
    patch: null,       // the last edit LAIN made to an open file
    patchTimer: 0,
    quickSel: 0,
  };

  function esc(s) {
    return String(s == null ? '' : s)
      .split('&').join('&amp;').split('<').join('&lt;').split('>').join('&gt;');
  }

  // ---- the small highlighter -------------------------------------------
  //
  // ONE LINE AT A TIME, over ALREADY-ESCAPED text. Order matters: comments and
  // strings are consumed first so a keyword inside either is not re-coloured.
  var KEYWORDS = {
    js: 'const let var function return if else for while class new await async import export from default try catch finally throw typeof instanceof this null true false undefined extends super yield delete in of do switch case break continue',
    ts: 'const let var function return if else for while class new await async import export from default try catch finally throw typeof instanceof this null true false undefined interface type enum implements public private protected readonly extends super as satisfies',
    css: 'important media supports keyframes import charset font-face root',
    html: 'html head body div span script style link meta title class id',
    json: 'true false null',
    md: '',
    py: 'def class return if elif else for while import from as try except finally raise with lambda None True False and or not in is pass break continue global nonlocal yield async await',
    rs: 'fn let mut const struct enum impl trait pub use mod match if else for while loop return self Self where async await move ref dyn crate super as in break continue',
    yaml: 'true false null yes no on off',
    sh: 'if then else elif fi for while do done case esac function return export local readonly source echo cd',
    text: '',
  };

  function kwRe(lang) {
    var words = (KEYWORDS[lang] || '').trim();
    if (!words) return null;
    // SPLIT ON A SPACE, not on a whitespace class: the KEYWORDS table above is
    // written with single spaces, so a class buys nothing and costs a
    // doubly-escaped regex LITERAL inside this emitted script — which reads, in
    // the source file, exactly like the lost-backslash corruption the
    // architecture guard exists to catch. Being unambiguous here is cheaper
    // than teaching that guard to tell the two apart.
    return new RegExp('\\\\b(' + words.split(' ').join('|') + ')\\\\b', 'g');
  }

  // BUILT FROM A STRING for the same reason: as a literal this needs four
  // backslashes to emit two, and that is indistinguishable in the source from
  // a regex that lost its escape.
  var NUMBER_RE = new RegExp('\\\\b(\\\\d+(?:\\\\.\\\\d+)?(?:px|em|rem|%|s|ms)?)\\\\b', 'g');

  /**
   * ONE PASS OVER THE RAW LINE, EMITTING ESCAPED TEXT AND SPANS.
   *
   * ---- WHY NOT CHAINED replace() CALLS, WHICH IS WHAT THIS WAS ----------
   *
   * The first version escaped the line and then ran five replacements over the
   * result. Each pass could see the markup the previous ones had emitted, and
   * the keyword pass duly matched the word "class" inside the span markup
   * an earlier pass had emitted, and wrapped it:
   *
   *     <span <span class="tk-k">class</span>="tk-n">1</span>
   *
   * Broken markup, from a highlighter, over the person's source code. No
   * amount of lookahead fixes it — the input to each pass is contaminated.
   *
   * A SINGLE PASS CANNOT HAVE THE BUG. The scanner walks the ORIGINAL text,
   * decides what each run is, and escapes it on the way out. Emitted markup is
   * never re-scanned because the scanner never looks at its own output.
   */
  function esc1(ch) {
    return ch === '&' ? '&amp;' : ch === '<' ? '&lt;' : ch === '>' ? '&gt;' : ch;
  }

  function span(cls, text) { return '<span class="tk-' + cls + '">' + esc(text) + '</span>'; }

  function highlight(line, lang) {
    var src = String(line == null ? '' : line);
    var kw = KEYWORDS[lang] ? (' ' + KEYWORDS[lang] + ' ') : '';
    var lineComment = (lang === 'js' || lang === 'ts' || lang === 'rs' || lang === 'css') ? '//'
      : (lang === 'py' || lang === 'yaml' || lang === 'sh') ? '#' : null;
    var out = '';
    var i = 0;

    while (i < src.length) {
      var ch = src[i];

      // A COMMENT RUNS TO THE END OF THE LINE. Nothing after it is code, so
      // this is checked first and consumes the remainder.
      if (lineComment && src.substr(i, lineComment.length) === lineComment) {
        out += span('c', src.slice(i));
        break;
      }
      if ((lang === 'js' || lang === 'ts' || lang === 'css' || lang === 'rs') && src.substr(i, 2) === '/*') {
        var close = src.indexOf('*/', i + 2);
        var stop = close < 0 ? src.length : close + 2;
        out += span('c', src.slice(i, stop));
        i = stop;
        continue;
      }

      // A STRING. Consumed whole, escapes included, so a quote inside it
      // cannot end it early.
      if (ch === '"' || ch === "'" || ch === '\`') {
        var j = i + 1;
        while (j < src.length && src[j] !== ch) { j += (src[j] === '\\\\' ? 2 : 1); }
        out += span('s', src.slice(i, Math.min(j + 1, src.length)));
        i = Math.min(j + 1, src.length);
        continue;
      }

      // ---- CHARACTER TESTS, NOT REGEX LITERALS -------------------------
      //
      // Every backslash below would need doubling to survive the template
      // literal this file emits, and a doubled one reads in the source exactly
      // like the lost-backslash corruption the architecture guard hunts for.
      // Two escaping problems at once, in code whose whole job is scanning
      // characters — so it scans characters.
      var isAlpha = function (c) { return (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z'); };
      var isDigit = function (c) { return c >= '0' && c <= '9'; };
      var isWord = function (c) { return isAlpha(c) || isDigit(c) || c === '_' || c === '$' || c === '-'; };

      // A TAG NAME in markup.
      if (lang === 'html' && ch === '<') {
        var t = i + 1;
        if (src[t] === '/') t += 1;
        if (isAlpha(src[t])) {
          var tagStart = t;
          while (t < src.length && isWord(src[t])) t += 1;
          if (t > tagStart) { out += span('t', src.slice(i, t)); i = t; continue; }
        }
      }

      // A NUMBER, with an optional CSS unit.
      if (isDigit(ch)) {
        var n = i;
        while (n < src.length && (isDigit(src[n]) || src[n] === '.')) n += 1;
        var unit = ['px', 'rem', 'em', 'ms', '%', 's'];
        for (var u = 0; u < unit.length; u++) {
          if (src.substr(n, unit[u].length) === unit[u]) { n += unit[u].length; break; }
        }
        out += span('n', src.slice(i, n));
        i = n;
        continue;
      }

      // A WORD. Coloured only when the language's keyword table has it, and
      // matched on whole words by padding both sides with spaces.
      if (isAlpha(ch) || ch === '_' || ch === '$') {
        var e = i;
        while (e < src.length && isWord(src[e])) e += 1;
        var word = src.slice(i, e);
        out += (kw && kw.indexOf(' ' + word + ' ') >= 0) ? span('k', word) : esc(word);
        i = e;
        continue;
      }

      out += esc1(ch);
      i += 1;
    }
    return out;
  }

  // ---- rendering --------------------------------------------------------
  function current() { return st.active >= 0 ? st.open[st.active] : null; }

  function renderEditor() {
    var f = current();
    $('srcEmpty').hidden = Boolean(f);
    $('srcGut').hidden = !f;
    $('srcCode').hidden = !f;
    if (!f) { $('srcPath').textContent = 'no file open'; $('srcLang').textContent = ''; return; }
    $('srcPath').textContent = f.path;
    $('srcLang').textContent = f.language;
    if ($('srcText').value !== f.body) $('srcText').value = f.body;
    paint();
  }

  function paint() {
    var f = current();
    if (!f) return;
    var lines = f.body.split('\\n');
    var hit = {};
    st.hits.forEach(function (n) { hit[n] = true; });
    $('srcHi').innerHTML = lines.map(function (l, i) {
      return '<span class="ln' + (hit[i] ? ' hit' : '') + '">' + (highlight(l, f.language) || ' ') + '</span>';
    }).join('\\n');
    $('srcGut').innerHTML = lines.map(function (l, i) {
      return '<div' + (hit[i] ? ' class="hit"' : '') + '>' + (i + 1) + '</div>';
    }).join('');
  }

  function renderTabs() {
    var bar = $('srcTabs');
    bar.textContent = '';
    st.open.forEach(function (f, i) {
      var t = document.createElement('div');
      t.className = 'srcTab';
      t.setAttribute('aria-selected', String(i === st.active));
      if (f.dirty) { var d = document.createElement('span'); d.className = 'dot'; t.appendChild(d); }
      var n = document.createElement('span');
      n.textContent = f.path.split('/').pop();
      n.title = f.path;
      n.onclick = function () { st.active = i; st.hits = []; renderTabs(); renderEditor(); };
      t.appendChild(n);
      var x = document.createElement('span');
      x.className = 'x';
      x.textContent = '\\u00d7';
      x.onclick = function (e) { e.stopPropagation(); close(i); };
      t.appendChild(x);
      bar.appendChild(t);
    });
  }

  function close(i) {
    var f = st.open[i];
    if (f && f.dirty && !window.confirm(f.path + ' has unsaved changes. Close it?')) return;
    st.open.splice(i, 1);
    if (st.active >= st.open.length) st.active = st.open.length - 1;
    renderTabs(); renderEditor();
  }

  function renderTree() {
    var box = $('srcTree');
    box.textContent = '';
    var draw = function (dirPath, depth) {
      var entries = st.tree[dirPath] || [];
      entries.forEach(function (e) {
        var row = document.createElement('div');
        row.className = 'srcRow' + (e.dir ? ' dir' : '');
        row.style.paddingLeft = (10 + depth * 12) + 'px';
        var tw = document.createElement('span');
        tw.className = 'tw';
        tw.textContent = e.dir ? (st.expanded[e.path] ? '\\u25be' : '\\u25b8') : '';
        row.appendChild(tw);
        var nm = document.createElement('span');
        nm.className = 'nm';
        nm.textContent = e.name;
        row.appendChild(nm);
        if (e.changed) { var c = document.createElement('span'); c.className = 'ch'; c.title = 'changed this session'; row.appendChild(c); }
        row.onclick = function () {
          if (e.dir) { toggle(e.path, depth); } else if (e.text) { openFile(e.path); }
          else notice(e.name + ' is not a text file');
        };
        box.appendChild(row);
        if (e.dir && st.expanded[e.path]) draw(e.path, depth + 1);
      });
    };
    draw('.', 0);
  }

  async function toggle(p, depth) {
    if (st.expanded[p]) { st.expanded[p] = false; renderTree(); return; }
    var r = await api('/api/files/tree', { path: p });
    if (!r.ok) { notice(r.why, true); return; }
    st.tree[p] = r.entries;
    st.expanded[p] = true;
    renderTree();
  }

  async function loadRoot() {
    var r = await api('/api/files/tree', { path: '' });
    if (!r.ok) { notice(r.why, true); return; }
    st.tree['.'] = r.entries;
    renderTree();
  }

  // ---- opening, saving --------------------------------------------------
  async function openFile(p, opts) {
    var at = -1;
    st.open.forEach(function (f, i) { if (f.path === p) at = i; });
    if (at >= 0) {
      st.active = at;
      st.hits = [];
      renderTabs(); renderEditor();
      if (opts && opts.line != null) gotoLine(opts.line);
      return true;
    }
    var r = await api('/api/files/open', { path: p });
    if (!r.ok) { notice(r.why, true); return false; }
    // A FEW TABS, NOT DOZENS. The blueprint asks for "several open tabs, not
    // dozens": past eight, the oldest CLEAN one goes, because a dirty buffer
    // is unsaved work and closing it silently would destroy it.
    if (st.open.length >= 8) {
      var victim = -1;
      st.open.forEach(function (f, i) { if (victim < 0 && !f.dirty) victim = i; });
      if (victim >= 0) st.open.splice(victim, 1);
    }
    st.open.push({
      path: r.path, body: r.body, saved: r.body, hash: r.hash, mtimeMs: r.mtimeMs,
      language: r.language, dirty: false,
    });
    st.active = st.open.length - 1;
    st.hits = [];
    renderTabs(); renderEditor();
    if (opts && opts.line != null) gotoLine(opts.line);
    return true;
  }

  function gotoLine(n) {
    var f = current();
    if (!f) return;
    var idx = Math.max(0, Math.min(f.body.split('\\n').length - 1, Number(n) - 1));
    st.hits = [idx];
    paint();
    var gut = $('srcGut').children[idx];
    if (gut) gut.scrollIntoView({ block: 'center' });
  }

  function note(text, bad, action) {
    var n = $('srcNote');
    if (!text) { n.hidden = true; n.textContent = ''; return; }
    n.hidden = false;
    n.className = 'srcNote' + (bad ? ' bad' : '');
    n.textContent = text;
    if (action) {
      var b = document.createElement('button');
      b.textContent = action.label;
      b.onclick = action.run;
      n.appendChild(b);
    }
  }

  async function save(force) {
    var f = current();
    if (!f) return;
    var r = await api('/api/files/save', {
      path: f.path, body: f.body, hash: f.hash, mtimeMs: f.mtimeMs, force: Boolean(force),
    });
    if (r.stale) {
      // THE INTERESTING CASE, and the one this product creates constantly:
      // LAIN edited the file while it was open. Both versions exist; the
      // person decides. Nothing is overwritten by default.
      note(r.why, true, {
        label: 'Reload from disk',
        run: function () { f.body = r.current; f.saved = r.current; f.hash = r.hash; f.mtimeMs = r.mtimeMs; f.dirty = false; note(''); renderTabs(); renderEditor(); },
      });
      return;
    }
    if (r.truncation) { note(r.why, true, { label: 'Save anyway', run: function () { save(true); } }); return; }
    if (!r.ok) { note(r.why || 'could not save', true); return; }
    f.saved = f.body; f.hash = r.hash; f.mtimeMs = r.mtimeMs; f.dirty = false;
    note('');
    renderTabs();
    if (poll) poll();
  }

  /**
   * DID ANYTHING MOVE UNDER US? Called from the ordinary poll.
   *
   * A CLEAN buffer is reloaded silently — that is LAIN editing a file the
   * person is watching, which is the feature. A DIRTY one is never touched;
   * it says so and waits, because the alternative is discarding typing.
   */
  async function refresh() {
    if (!st.open.length) return;
    var r = await api('/api/files/freshness', {
      open: st.open.map(function (f) { return { path: f.path, hash: f.hash, mtimeMs: f.mtimeMs }; }),
    });
    if (!r.ok || !r.files) return;
    var repainted = false;
    for (var i = 0; i < r.files.length; i++) {
      var info = r.files[i];
      var f = st.open[i];
      if (!f || !info.changed || info.gone) continue;
      if (f.dirty) { if (i === st.active) note(f.path + ' changed on disk, and you have unsaved edits', true); continue; }
      var fresh = await api('/api/files/open', { path: f.path });
      if (!fresh.ok) continue;
      // ---- THE PATCH, NOT A SILENT SWAP ---------------------------------
      //
      // The blueprint asks the person to SEE what LAIN changed:
      //     - opacity: 0.2
      //     + opacity: 0.5
      // Replacing the buffer and repainting would show the RESULT and hide the
      // CHANGE, which is the one thing worth watching. So the changed lines are
      // computed here and marked, and the patch is stated above the editor.
      //
      // NOT TOKEN-BY-TOKEN TYPING. This renders a real write event that already
      // happened, once, when it happened.
      var patch = diff(f.body, fresh.body);
      f.body = fresh.body; f.saved = fresh.body; f.hash = fresh.hash; f.mtimeMs = fresh.mtimeMs;
      st.patch = { path: f.path, at: Date.now(), lines: patch.changed, removed: patch.removed, added: patch.added };
      if (i === st.active) {
        st.hits = patch.changed;
        showPatch(patch, f.path);
      }
      repainted = true;
    }
    if (repainted) { renderTabs(); renderEditor(); }
  }

  /**
   * THE SMALLEST DIFF THAT ANSWERS THE QUESTION.
   *
   * A COMMON-PREFIX / COMMON-SUFFIX TRIM, not Myers. For the shape of edit that
   * actually happens here — a model changing one property, one line, one block —
   * it produces exactly the right answer for a few lines of code. It degrades
   * to "these N lines changed" on a large rewrite, which is also the honest
   * answer: nobody reads a 300-line inline patch.
   */
  function diff(before, after) {
    var a = String(before).split('\\n');
    var b = String(after).split('\\n');
    var head = 0;
    while (head < a.length && head < b.length && a[head] === b[head]) head++;
    var tail = 0;
    while (tail < (a.length - head) && tail < (b.length - head)
           && a[a.length - 1 - tail] === b[b.length - 1 - tail]) tail++;
    var removed = a.slice(head, a.length - tail);
    var added = b.slice(head, b.length - tail);
    var changed = [];
    for (var i = 0; i < added.length; i++) changed.push(head + i);
    return { head: head, removed: removed, added: added, changed: changed };
  }

  function showPatch(patch, p) {
    if (!patch.removed.length && !patch.added.length) return;
    var n = $('srcNote');
    n.hidden = false;
    n.className = 'srcNote';
    n.textContent = '';
    var head = document.createElement('div');
    head.textContent = 'LAIN edited ' + p + '  ·  line ' + (patch.head + 1);
    n.appendChild(head);
    var show = function (rows, sign, cls) {
      rows.slice(0, 6).forEach(function (l) {
        var d = document.createElement('div');
        d.className = cls;
        d.style.fontFamily = 'var(--mono)';
        d.textContent = sign + ' ' + l.trim();
        n.appendChild(d);
      });
    };
    show(patch.removed, '-', 'del');
    show(patch.added, '+', 'add');
    // IT FADES. A patch is news for a moment; leaving it above the editor for
    // the rest of the session makes it furniture.
    window.clearTimeout(st.patchTimer);
    st.patchTimer = window.setTimeout(function () { note(''); st.hits = []; paint(); }, 12000);
  }

  // ---- find -------------------------------------------------------------
  function find(q) {
    var f = current();
    st.hits = [];
    if (f && q) {
      var needle = q.toLowerCase();
      f.body.split('\\n').forEach(function (l, i) { if (l.toLowerCase().indexOf(needle) >= 0) st.hits.push(i); });
    }
    paint();
    if (st.hits.length) {
      var g = $('srcGut').children[st.hits[0]];
      if (g) g.scrollIntoView({ block: 'center' });
    }
    return st.hits.length;
  }

  // ---- quick open -------------------------------------------------------
  async function quick(q) {
    var r = await api('/api/files/find', { q: q });
    var box = $('quickHits');
    box.textContent = '';
    st.quickSel = 0;
    ((r && r.matches) || []).forEach(function (m, i) {
      var d = document.createElement('div');
      d.className = 'hit';
      d.setAttribute('aria-selected', String(i === 0));
      d.textContent = m.path;
      d.onclick = function () { closeQuick(); openFile(m.path); };
      box.appendChild(d);
    });
  }
  function openQuick() { $('quick').hidden = false; $('quickQ').value = ''; $('quickHits').textContent = ''; $('quickQ').focus(); }
  function closeQuick() { $('quick').hidden = true; }

  // ---- wiring -----------------------------------------------------------
  function boot(apiFn, noticeFn, pollFn) {
    api = apiFn; notice = noticeFn; poll = pollFn;

    $('srcText').addEventListener('input', function () {
      var f = current();
      if (!f) return;
      f.body = this.value;
      f.dirty = f.body !== f.saved;
      paint();
      renderTabs();
    });
    // THE HIGHLIGHT LAYER FOLLOWS THE TEXTAREA, or the colour drifts off the
    // characters the moment anything scrolls.
    $('srcText').addEventListener('scroll', function () {
      $('srcHi').scrollTop = this.scrollTop;
      $('srcHi').scrollLeft = this.scrollLeft;
    });
    $('srcText').addEventListener('keydown', function (e) {
      if (e.key === 'Tab') {
        e.preventDefault();
        var s = this.selectionStart, en = this.selectionEnd;
        this.value = this.value.slice(0, s) + '  ' + this.value.slice(en);
        this.selectionStart = this.selectionEnd = s + 2;
        this.dispatchEvent(new Event('input'));
      }
      if ((e.ctrlKey || e.metaKey) && e.key === 's') { e.preventDefault(); save(false); }
    });
    $('srcSave').onclick = function () { save(false); };
    $('srcFindBtn').onclick = function () {
      var q = window.prompt('Find in this file');
      if (q == null) return;
      var n = find(q);
      notice(n ? n + ' match(es)' : 'no match');
    };
    $('quickQ').addEventListener('input', function () { quick(this.value); });
    $('quickQ').addEventListener('keydown', function (e) {
      if (e.key === 'Escape') closeQuick();
      if (e.key === 'Enter') {
        var sel = $('quickHits').children[st.quickSel];
        if (sel) { closeQuick(); openFile(sel.textContent); }
      }
    });
    document.addEventListener('keydown', function (e) {
      if ((e.ctrlKey || e.metaKey) && e.key === 'p') { e.preventDefault(); openQuick(); }
      if (e.key === 'Escape' && !$('quick').hidden) closeQuick();
    });
    $('quick').addEventListener('click', function (e) { if (e.target === this) closeQuick(); });
  }

  return {
    boot: boot, loadRoot: loadRoot, openFile: openFile, gotoLine: gotoLine,
    refresh: refresh, renderTree: renderTree, find: find, save: save, diff: diff,
    state: function () { return st; },
    highlight: highlight,
  };
})();
`;
}

module.exports = { CSS, HTML, js };
