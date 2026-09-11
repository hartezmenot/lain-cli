'use strict';

/**
 * THE APPLICATION SHELL — one document, no build step.
 *
 * ------------------------------------------------------------------------
 * WHAT THIS FILE IS AND IS NOT.
 *
 * It is the HTML skeleton and the whole of the visual language. It contains no
 * behaviour: the script comes from pagescript.js (the lanes, the sessions, the
 * conversation, the composer, the model picker) and pageworkshop.js (the
 * preview and its instruments), composed in below.
 *
 * The split is the god-object guard doing its job, and the seam is real —
 * "what it looks like" and "what it does" change for different reasons.
 *
 * ------------------------------------------------------------------------
 * THE VISUAL LANGUAGE, WHICH IS THE CLI'S.
 *
 * Near-black ground, one cyan accent, restrained semantic colour (green for
 * proved, amber for waiting, red for failed), generous whitespace, and NO
 * BOXES AROUND EVERYTHING. A person moving between the terminal and this
 * should recognise the same product rather than two designs that share a name.
 *
 * PROGRESSIVE DISCLOSURE IS THE LAYOUT RULE. The resting screen is a session
 * list, a conversation and a composer. Changes, verification and the Workshop
 * are contextual: they appear when there is something in them, and the Workshop
 * takes the right half only while it is open. There is no permanent process
 * monitor, no permanent event stream and no grid of status cards.
 */

/** The one accent, and the semantic colours. Kept together so they stay related. */
const CSS = `
:root{
  --bg:#0b0d10; --panel:#0f1216; --line:#1c222b; --ink:#dfe6ee; --dim:#8b97a6;
  --faint:#5b6675; --accent:#49b6ff; --ok:#4ec98a; --warn:#e0b341; --bad:#e86a6a;
  --grey:#161b22; --radius:6px;
  --mono:ui-monospace,SFMono-Regular,"SF Mono",Menlo,Consolas,monospace;
  --sans:system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;
}
*{box-sizing:border-box}
html,body{height:100%;margin:0}
body{background:var(--bg);color:var(--ink);font:14px/1.55 var(--sans);overflow:hidden}
button{font:inherit;color:inherit;background:none;border:0;cursor:pointer}
button:disabled{opacity:.4;cursor:default}
input,textarea{font:inherit;color:inherit;background:none;border:0;outline:0;width:100%}

/* ---- the frame -------------------------------------------------------- */
#app{display:grid;grid-template-rows:auto 1fr;height:100%}
header{display:flex;align-items:center;gap:22px;padding:0 18px;height:46px;border-bottom:1px solid var(--line)}
.brand{font-weight:650;letter-spacing:.14em;font-size:12px;color:var(--accent)}
.lanes{display:flex;gap:2px}
.lane{padding:5px 13px;border-radius:var(--radius);color:var(--dim);font-size:13px}
.lane[aria-selected=true]{background:var(--grey);color:var(--ink)}
.spacer{flex:1}
.hint{color:var(--faint);font-size:12px}

main{display:grid;grid-template-columns:250px 1fr;min-height:0}
main.with-workshop{grid-template-columns:250px 1fr minmax(420px,44%)}
/* THE SOURCE COLUMN. With both open the conversation yields, because a person
   correlating a rendered element to its code is looking at those two. */
main.with-source{grid-template-columns:250px 1fr minmax(460px,46%)}
main.with-source.with-workshop{grid-template-columns:200px minmax(0,1fr) minmax(380px,34%) minmax(360px,32%)}

/* ---- sessions --------------------------------------------------------- */
aside{border-right:1px solid var(--line);overflow-y:auto;padding:14px 0}
.aside-head{padding:0 16px 10px;color:var(--faint);font-size:11px;letter-spacing:.1em;text-transform:uppercase}
.sess{display:block;width:100%;text-align:left;padding:8px 16px;border-left:2px solid transparent}
.sess:hover{background:#12161c}
.sess[aria-current=true]{border-left-color:var(--accent);background:#12161c}
.sess .p{font-size:13px;color:var(--ink)}
.sess .t{font-size:12px;color:var(--dim);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.sess .w{font-size:11px;color:var(--faint);margin-top:2px}
.src{display:inline-block;font-size:10px;letter-spacing:.06em;text-transform:uppercase;
     color:var(--faint);border:1px solid var(--line);border-radius:3px;padding:0 5px;margin-left:6px}
.empty{padding:18px 16px;color:var(--faint);font-size:12px;line-height:1.6}

/* ---- the work column -------------------------------------------------- */
section.work{display:grid;grid-template-rows:auto 1fr auto;min-height:0}
.crumb{display:flex;align-items:baseline;gap:12px;padding:12px 22px;border-bottom:1px solid var(--line)}
.crumb .proj{font-weight:600}
.crumb .goal{color:var(--dim);font-size:12.5px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.stream{overflow-y:auto;padding:20px 22px 8px}
.msg{margin:0 0 20px;max-width:78ch}
.msg .who{font-size:11px;letter-spacing:.1em;text-transform:uppercase;color:var(--faint);margin-bottom:5px}
.msg.user .body{background:var(--grey);border-radius:var(--radius);padding:10px 13px;white-space:pre-wrap}
.msg.assistant .body{white-space:pre-wrap}
.prov{color:var(--accent);text-transform:none;letter-spacing:0;margin-left:8px;font-size:11px}

/* ---- activity, contextual -------------------------------------------- */
.act{display:flex;align-items:center;gap:9px;padding:8px 22px;border-top:1px solid var(--line);font-size:12.5px;color:var(--dim)}
.dot{width:7px;height:7px;border-radius:50%;background:var(--faint);flex:none}
.dot.run{background:var(--accent);animation:p 1.4s ease-in-out infinite}
.dot.ok{background:var(--ok)} .dot.bad{background:var(--bad)} .dot.warn{background:var(--warn)}
@keyframes p{0%,100%{opacity:.35}50%{opacity:1}}
.clock{margin-left:auto;font-family:var(--mono);font-size:12px;color:var(--faint)}

/* ---- composer --------------------------------------------------------- */
.composer{border-top:1px solid var(--line);padding:12px 22px 16px}
.box{background:var(--grey);border-radius:var(--radius);padding:11px 13px}
.box textarea{resize:none;min-height:22px;max-height:180px;display:block}
.box textarea::placeholder{color:var(--faint)}
.tools{display:flex;align-items:center;gap:8px;margin-top:10px}
.pill{display:flex;align-items:center;gap:7px;padding:4px 10px;border:1px solid var(--line);
      border-radius:99px;color:var(--dim);font-size:12px}
.pill:hover{border-color:#2b3542;color:var(--ink)}
.pill b{font-weight:500;color:var(--ink)}
.pill .st{width:6px;height:6px;border-radius:50%;background:var(--faint)}
.pill .st.ready{background:var(--ok)} .pill .st.auth{background:var(--warn)} .pill .st.bad{background:var(--bad)}
/* The environment chip is a LABEL, not a button: no hover, no pointer, and it
   recedes until something is worth saying. A borrowed browser is the one state
   that earns a colour, because it is the one a person may want to change. */
.pill.env{cursor:default;color:var(--faint);border-style:dashed;font-size:11px}
.pill.env:hover{border-color:var(--line);color:var(--faint)}
.pill.env.warn{color:var(--warn);border-color:var(--warn)}
.send{margin-left:auto;padding:5px 15px;border-radius:var(--radius);background:var(--accent);color:#04121d;font-weight:600}
.send:disabled{background:#243440;color:var(--faint)}

/* ---- contextual drawers ---------------------------------------------- */
.drawers{display:flex;gap:6px;padding:0 22px 12px;flex-wrap:wrap}
.tab{padding:4px 11px;border-radius:var(--radius);color:var(--dim);font-size:12px;border:1px solid transparent}
.tab:hover{color:var(--ink)}
.tab[aria-selected=true]{background:var(--grey);color:var(--ink)}
.tab .n{color:var(--faint);margin-left:5px;font-size:11px}
.drawer{padding:0 22px 14px;max-height:34vh;overflow-y:auto}
.row{display:flex;gap:10px;padding:4px 0;font-family:var(--mono);font-size:12px;color:var(--dim)}
.row .path{color:var(--ink)}
.add{color:var(--ok)} .del{color:var(--bad)}
.verdict{font-size:12.5px;padding:8px 0}
.verdict .PASSED{color:var(--ok)} .verdict .FAILED{color:var(--bad)} .verdict .INCONCLUSIVE{color:var(--warn)}

${require('./pagesource').CSS}
/* ---- the workshop ----------------------------------------------------- */
.workshop{border-left:1px solid var(--line);display:grid;grid-template-rows:auto auto 1fr auto;min-height:0}
.ws-head{display:flex;align-items:center;gap:10px;padding:11px 16px;border-bottom:1px solid var(--line)}
.ws-title{font-size:12px;letter-spacing:.1em;text-transform:uppercase;color:var(--faint)}
.ws-bar{display:flex;align-items:center;gap:6px;padding:9px 16px;border-bottom:1px solid var(--line);flex-wrap:wrap}
.vp{padding:3px 10px;border-radius:var(--radius);font-size:12px;color:var(--dim)}
.vp[aria-selected=true]{background:var(--grey);color:var(--ink)}
.ws-body{overflow:auto;padding:14px 16px;min-height:0}
.shot{width:100%;border:1px solid var(--line);border-radius:var(--radius);display:block;background:#fff}
.ba{display:grid;grid-template-columns:1fr 1fr;gap:10px}
.ba figcaption{font-size:11px;color:var(--faint);text-transform:uppercase;letter-spacing:.08em;margin-bottom:5px}
.kv{display:grid;grid-template-columns:auto 1fr;gap:3px 14px;font-family:var(--mono);font-size:12px;margin:8px 0}
.kv dt{color:var(--faint)} .kv dd{margin:0;color:var(--ink);word-break:break-all}
.obs{font-family:var(--mono);font-size:11.5px;color:var(--dim);padding:2px 0;word-break:break-all}
.obs.err{color:var(--bad)}
.ws-foot{border-top:1px solid var(--line);padding:10px 16px;display:flex;gap:8px;flex-wrap:wrap}
.btn{padding:5px 12px;border:1px solid var(--line);border-radius:var(--radius);color:var(--dim);font-size:12px}
.btn:hover{border-color:#2b3542;color:var(--ink)}
.btn.go{border-color:#1d4a66;color:var(--accent)}

/* ---- popovers, login, notices ---------------------------------------- */
.pop{position:fixed;background:var(--panel);border:1px solid var(--line);border-radius:var(--radius);
     padding:6px;min-width:250px;max-height:60vh;overflow-y:auto;z-index:40;box-shadow:0 12px 34px #0009}
.pop h4{margin:6px 8px;font-size:10.5px;letter-spacing:.1em;text-transform:uppercase;color:var(--faint);font-weight:600}
.opt{display:block;width:100%;text-align:left;padding:6px 9px;border-radius:4px;font-size:13px;color:var(--dim)}
.opt:hover{background:var(--grey);color:var(--ink)}
.opt[aria-selected=true]{color:var(--ink)}
.opt small{display:block;color:var(--faint);font-size:11px}
.gate{position:fixed;inset:0;background:var(--bg);display:grid;place-items:center;z-index:60}
.gate form{width:330px}
.gate h1{font:650 13px/1 var(--sans);letter-spacing:.16em;color:var(--accent);margin:0 0 18px}
.gate .box{margin-bottom:10px}
.note{padding:9px 22px;font-size:12.5px;color:var(--warn);border-top:1px solid var(--line)}
.note.bad{color:var(--bad)}
`;

/**
 * THE DOCUMENT.
 *
 * Every dynamic region is empty here and filled by the script from
 * `/api/state`. Nothing is server-rendered, so there is exactly one place a
 * fact can come from and the page cannot show a stale render of one.
 */
/**
 * THE DOCUMENT.
 *
 * `handed` is a session credential the server minted for a one-time launch
 * token — see server.js. It is injected as a JS value rather than left in the
 * URL, and pagescript.js erases the token from the address bar before anything
 * else runs. When there is none (somebody opened the port by hand) the page
 * falls back to the password gate, which still works.
 */
function html({ session = null } = {}) {
  const handed = session ? JSON.stringify(String(session)) : 'null';
  return `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>LAIN Harness</title>
<style>${CSS}</style>
<script>window.__LAIN_HANDED__ = ${handed};</script>
</head><body>

<div class="gate" id="gate" hidden>
  <form id="gateForm">
    <h1>LAIN HARNESS</h1>
    <div class="box"><input id="pw" type="password" placeholder="Startup password" autocomplete="off" autofocus></div>
    <div class="hint" id="gateWhy">The password is printed in the terminal that started it.</div>
  </form>
</div>

<div id="app" hidden>
  <header>
    <span class="brand">LAIN</span>
    <div class="lanes" role="tablist">
      <button class="lane" role="tab" id="laneEng" aria-selected="true">Chat / Coding</button>
      <button class="lane" role="tab" id="laneCo" aria-selected="false">Cowork / Bot</button>
    </div>
    <span class="spacer"></span>
    <span class="hint" id="conn"></span>
  </header>

  <main id="main">
    <aside>
      <div class="aside-head" id="asideHead">Sessions</div>
      <div id="sessions"></div>
    </aside>

    <section class="work">
      <div class="crumb">
        <span class="proj" id="proj"></span>
        <span class="goal" id="goal"></span>
      </div>

      <div class="stream" id="stream"></div>

      <div id="notice" hidden></div>

      <div class="drawers" id="drawers"></div>
      <div class="drawer" id="drawer" hidden></div>

      <div class="act" id="act" hidden>
        <span class="dot" id="actDot"></span>
        <span id="actText"></span>
        <span class="clock" id="actClock"></span>
      </div>

      <div class="composer">
        <div class="box">
          <textarea id="ask" rows="1" placeholder="Ask LAIN…"></textarea>
        </div>
        <div class="tools">
          <button class="pill" id="srcPill"><span class="st" id="srcDot"></span><span id="srcName">LAIN</span></button>
          <button class="pill" id="modelPill"><b id="modelName">no model</b></button>
          <button class="pill" id="srcPill">Source</button>
          <button class="pill" id="wsPill">Workshop</button>
          <!-- WHERE THE WORK RUNS. One chip, no panel - see the environment
               projection in state.js on why this stays small. It is a LABEL,
               not a control: changing environment is a task decision, not a
               click here.
               NO BACKTICKS IN THIS FILE, in comments included - the whole page
               is one template literal, and a stray backtick ends it. That has
               now cost two passes. -->
          <span class="pill env" id="envPill" title="execution environment"></span>
          <button class="send" id="send">Send</button>
        </div>
      </div>
    </section>

    ${require('./pagesource').HTML}

    <section class="workshop" id="workshop" hidden>
      <div class="ws-head">
        <span class="ws-title">Frontend Workshop</span>
        <span class="hint" id="wsUrl"></span>
        <span class="spacer"></span>
        <button class="btn" id="wsClose">Close</button>
      </div>
      <div class="ws-bar">
        <button class="vp" data-vp="desktop" aria-selected="true">Desktop</button>
        <button class="vp" data-vp="tablet" aria-selected="false">Tablet</button>
        <button class="vp" data-vp="mobile" aria-selected="false">Mobile</button>
        <span class="spacer"></span>
        <button class="btn" id="wsPick">Select element</button>
        <button class="btn" id="wsReload">Reload</button>
      </div>
      <div class="ws-body" id="wsBody"></div>
      <div class="ws-foot">
        <button class="btn" id="wsBefore">Capture before</button>
        <button class="btn" id="wsAfter">Capture after</button>
        <button class="btn go" id="wsVerify">Verify desktop + mobile</button>
        <button class="btn" id="wsAttach" disabled>Ask about selection</button>
      </div>
    </section>
  </main>
</div>

<script>${require('./pagescript').js()}</script>
<script>${require('./pageworkshop').js()}</script>
<script>${require('./pagesource').js()}</script>
<script>LAIN.boot();</script>
</body></html>`;
}

module.exports = { html, CSS };
