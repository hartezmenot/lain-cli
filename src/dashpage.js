'use strict';

/**
 * THE DASHBOARD PAGE — a conversation on a phone, not a status console.
 *
 * `/dash` served a stack of labelled sections: TASK, MODEL, ACTIVITY, CHANGED,
 * MCP, CONTROL. Every one of those was true, and together they answered
 * everything except the question a person actually opens their phone to ask —
 * WHAT IS HAPPENING? Reading a list of tool names is not reading a
 * conversation.
 *
 * So the page is now the conversation, in the shape every messaging app on a
 * phone already has: a title bar that says which project, a scrolling thread of
 * USER / LAIN / EXTERNAL / MCP / ACTION, a live status line pinned above the
 * composer, and a composer at the bottom. The facts that used to have sections
 * are still here, in a details drawer, because they are worth having and worth
 * nothing at the top of the screen.
 *
 * Split out of dash.js so that file stays the SERVER — routing, credentials,
 * the action allowlist — and this stays the presentation. dash.js was already at
 * the edge of the architecture guard carrying both.
 *
 * WHAT DOES NOT CHANGE, and must not:
 *
 *   READ-ONLY BY DEFAULT. The composer is disabled unless `/dash actions on`
 *   was run in the terminal. The server enforces that too (see dash.js); this
 *   only reflects it, because a UI that hides a button is not a permission
 *   system.
 *
 *   NO ARBITRARY EXECUTION. The composer sends a STEER — a message to the
 *   running task — through the same fixed action allowlist as every other
 *   control. There is no shell here, and there is no endpoint that would take
 *   one.
 *
 *   THE SESSION KEY travels on every request, and every value that reaches the
 *   DOM goes through `esc`. The conversation contains a model's output and a
 *   user's words; both are untrusted text as far as this page is concerned.
 *
 * ------------------------------------------------------------------------
 * ONE WORD FOR THE HUMAN HALF, ONE FOR THE MACHINE HALF.
 *
 * A PASSWORD is what a person types. It is the only credential anybody is ever
 * asked to know, and this page says "password" in every place a person reads.
 *
 * A SESSION KEY is what the browser holds after proving the password. Nobody
 * types it, nobody reads it, and it is never shown.
 *
 * Both used to be called "the token", which is why the gate could offer them as
 * equal alternatives and why a form could say "token" to somebody who had set a
 * password. That is not a labelling problem — it is one word doing two jobs,
 * and the two jobs have different lifetimes, different owners and different
 * risks.
 *
 * ------------------------------------------------------------------------
 * THE PASSWORD IS ASKED FOR, NOT CARRIED IN THE URL.
 *
 * It used to ride in the query string — `http://…/?t=<secret>` — which is the
 * one place a secret should never be. A URL is not a private channel: it lands
 * in browser history, in the address bar over somebody's shoulder, in every
 * proxy and server log along the way, and in the `Referer` of anything the page
 * later links to. Worse, it is the form people SHARE: copying that URL to a
 * phone copies the credential with it, permanently, into whatever pasted it.
 *
 * So this page carries NO credential and NO state. It is a static shell, served
 * to anyone who asks, and it holds nothing worth taking — every fact is behind
 * `/api/*`, which requires the session key on every request. The shell asks for
 * the password once, keeps the KEY it buys in `sessionStorage` (which dies with
 * the tab, unlike a cookie, and is never sent automatically anywhere), and
 * passes it as a header.
 *
 * A link that IS the credential becomes a link that ASKS for one.
 */

/** The colour of each actor, matching the terminal's semantic palette. */
const ACTOR_CSS = `
.msg{padding:10px 14px;border-bottom:1px solid var(--line)}
.who{font-size:11px;letter-spacing:.14em;font-weight:600;margin-bottom:3px}
.msg .body{white-space:pre-wrap;word-break:break-word}
.USER .who{color:var(--fg)}
.USER .body{color:var(--fg)}
.LAIN .who{color:var(--ok)}
.EXTERNAL .who{color:var(--ext)}
.MCP .who{color:var(--warn)}
.ACTION{padding:3px 14px;border:0}
.ACTION .body{color:var(--dim);font-size:13px}
`;

/**
 * The password gate. Shown until the server accepts what was typed, and shown
 * again the moment it stops accepting it — a session that was revoked because
 * LAIN restarted must not leave a stale page pretending to be connected.
 */
const GATE_CSS = `
#gate{position:fixed;inset:0;background:var(--bg);display:none;flex-direction:column;
 align-items:center;justify-content:center;gap:14px;padding:24px;z-index:10}
#gate.on{display:flex}
#gate h2{margin:0;font-size:15px;letter-spacing:.1em;font-weight:600}
#gate p{margin:0;color:var(--dim);font-size:13px;text-align:center;max-width:34em;line-height:1.6}
#gate form{display:flex;gap:8px;width:100%;max-width:26em}
#gatemsg{color:var(--bad);font-size:13px;min-height:1.2em}
`;

/**
 * NO ARGUMENT. This took the credential and baked it into the script; it takes
 * nothing now, because the page is a shell that knows no secrets. See the
 * header for why the URL is the wrong place for one.
 */
function page() {
  return `<!doctype html><html><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<title>LAIN</title><style>
:root{--bg:#0e1116;--fg:#d7dde5;--dim:#7c8798;--ok:#4ec97a;--warn:#e3b341;--bad:#f2705d;--ext:#c678dd;--line:#232935}
*{box-sizing:border-box}
html,body{height:100%}
body{margin:0;background:var(--bg);color:var(--fg);font:15px/1.55 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;
 display:flex;flex-direction:column}
header{padding:12px 14px;border-bottom:1px solid var(--line);background:var(--bg);flex:0 0 auto}
h1{margin:0;font-size:15px;letter-spacing:.04em}
.sub{color:var(--dim);font-size:12px;margin-top:2px}
#thread{flex:1 1 auto;overflow-y:auto;-webkit-overflow-scrolling:touch}
${ACTOR_CSS}
#live{flex:0 0 auto;padding:8px 14px;border-top:1px solid var(--line);color:var(--dim);font-size:13px;
 font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace}
#bar{flex:0 0 auto;display:flex;gap:8px;padding:10px 12px calc(10px + env(safe-area-inset-bottom));border-top:1px solid var(--line)}
input{flex:1 1 auto;font:inherit;background:#1a2029;color:var(--fg);border:1px solid var(--line);border-radius:20px;padding:10px 14px;min-width:0}
button{font:inherit;background:#1a2029;color:var(--fg);border:1px solid var(--line);border-radius:20px;padding:10px 16px;cursor:pointer}
button:active{background:#232b36}button[disabled],input[disabled]{opacity:.45}
.ok{color:var(--ok)}.warn{color:var(--warn)}.bad{color:var(--bad)}.dim{color:var(--dim)}
details{border-top:1px solid var(--line);flex:0 0 auto}
summary{padding:10px 14px;color:var(--dim);font-size:12px;letter-spacing:.1em;cursor:pointer}
.row{display:flex;justify-content:space-between;gap:12px;padding:2px 14px;font-size:13px}
.k{color:var(--dim)}.v{text-align:right;word-break:break-word}
#msg{color:var(--dim);font-size:12px;padding:0 14px 8px;min-height:1.1em}
#insts{display:flex;gap:6px;flex-wrap:wrap;margin-top:8px}
#insts a,#insts span{font-size:12px;padding:3px 9px;border-radius:12px;border:1px solid var(--line);
 color:var(--dim);text-decoration:none;white-space:nowrap}
#insts .here{border-color:var(--ok);color:var(--ok)}
${GATE_CSS}
</style></head><body>
<div id="gate"><h2>LAIN</h2>
<p id="gatehint">This dashboard is locked.</p>
<form id="gateform"><input id="pw" type="password" placeholder="password" autocomplete="current-password" autocapitalize="off" spellcheck="false"><button type="submit">Unlock</button></form>
<div id="gatemsg"></div></div>
<header><h1 id="proj">LAIN</h1><div class="sub" id="task">connecting…</div><div id="insts"></div></header>
<div id="thread"></div>
<details id="facts"><summary>DETAILS</summary><div id="detail"></div></details>
<div id="live"><span class="dim">○ idle</span></div>
<div id="msg"></div>
<div id="bar"><input id="steer" placeholder="Type a message…" autocomplete="off"><button id="send">Send</button></div>
<script>
// NO CREDENTIAL IS IN THIS SCRIPT. The password is typed into the gate and
// never stored; the SESSION KEY it buys is kept in sessionStorage, which is
// per-tab and dies with it. Sent as a header rather than a query parameter so
// it never reaches a URL, a log or a Referer.
const KEY='lain.dash.session';
let T=sessionStorage.getItem(KEY)||'';
// A LINK THAT STILL CARRIES ?t= IS HONOURED ONCE AND THEN SCRUBBED, so an old
// bookmark keeps working without leaving the credential in the address bar.
const q=new URL(location.href).searchParams.get('t');
if(q){T=q;sessionStorage.setItem(KEY,T);history.replaceState(null,'',location.pathname);}
const $=(id)=>document.getElementById(id);
const esc=(s)=>String(s==null?'':s).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const row=(k,v,cls)=>'<div class="row"><span class="k">'+esc(k)+'</span><span class="v '+(cls||'')+'">'+v+'</span></div>';
let atBottom=true;
$('thread').addEventListener('scroll',()=>{
  const el=$('thread');
  atBottom=el.scrollHeight-el.scrollTop-el.clientHeight<40;
});
const auth=()=>({'x-lain-session':T});
// ---- LOCKING IS IDEMPOTENT, AND THAT IS THE WHOLE BUG FIX -----------------
//
// THE FAILURE: you click the password box, type, and what you typed disappears.
// It is not the keyboard and it is not focus — it is this function, called on a
// 1.5s timer.
//
// tick() runs every 1500ms. Its first line is  if(!T){lock('');return;}  and
// while you are standing at the gate there IS no session key, so every tick
// re-entered lock() — which cleared the field, moved the caret and re-fetched
// /api/auth. Typing a password takes longer than 1.5 seconds, so the field
// emptied underneath every user, every time, and no password could ever be
// entered. The gate was not merely awkward; it was impossible to pass.
//
// EVERY PATH THAT REDRAWS THE GATE COMES THROUGH HERE, which is what makes the
// fix hold: the poll, a 401 on an action, a revoked session and a failed login
// all call lock(), and only the FIRST of them may touch the field.
//
// So locking now distinguishes ENTERING the locked state from BEING in it.
// Entering it clears the field and takes focus, once. Being in it does nothing
// at all — a repaint must never destroy what somebody is in the middle of
// typing. unlock() is what re-arms it.
let LOCKED=false;
function lock(why){
  const entering=!LOCKED;
  LOCKED=true;
  T='';sessionStorage.removeItem(KEY);
  $('gate').classList.add('on');
  // A REASON REPLACES A REASON; silence does not. A tick passing by must not
  // wipe "wrong password" off the screen a moment after it was put there.
  if(why||entering)$('gatemsg').textContent=why||'';
  if(entering){askWhat();$('pw').value='';$('pw').focus();}
}
function unlock(){LOCKED=false;$('gate').classList.remove('on');$('gatemsg').textContent='';}
// WHICH PASSWORD THIS LAIN WANTS — the one that was set, or the startup one it
// printed. Asked rather than assumed: wording that does not match what would
// actually be accepted is a form people cannot get through.
let WANTS_PASSWORD=false;
async function askWhat(){
  try{
    const r=await fetch('/api/auth');
    if(!r.ok)return;
    const j=await r.json();
    WANTS_PASSWORD=Boolean(j.password);
    // IT IS A PASSWORD EITHER WAY, and the field says so either way.
    //
    // The gate used to offer "token" as an equal alternative to the password,
    // which is what made the password look optional and what left the field
    // labelled with a word that matched neither thing. There is one kind of
    // credential here; what changes is only WHICH password is currently the
    // one that works.
    $('pw').placeholder='password';
    $('gatehint').textContent=WANTS_PASSWORD
      ?'This dashboard is locked. Enter the password you set with /dash password.'
      :'No password has been set for this dashboard yet. Enter the STARTUP PASSWORD LAIN printed '
       +'in the terminal when /dash started. Run /dash password there to choose one you can '
       +'remember — the startup password changes every time LAIN restarts.';
    if(j.lockedOut)$('gatemsg').textContent='too many failed attempts — restart LAIN to try again';
  }catch(e){/* the gate still works with its default wording */}
}
$('gateform').addEventListener('submit',async(e)=>{
  e.preventDefault();
  const v=$('pw').value.trim();
  if(!v)return;
  // VALIDATED AGAINST THE SERVER, never against anything in this page — the
  // page holds no copy of either credential, which is the point.
  if(WANTS_PASSWORD){
    // THE PASSWORD CROSSES ONCE and buys a session key; everything after this
    // sends the key. The password is never stored, never put in the URL and
    // never re-sent.
    const r=await fetch('/api/login',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({password:v})}).catch(()=>null);
    if(r&&r.ok){
      const j=await r.json();
      T=j.session||j.token;sessionStorage.setItem(KEY,T);$('pw').value='';unlock();tick();return;
    }
    const j=r?await r.json().catch(()=>({})):{};
    $('gatemsg').textContent=j.error||'no answer from LAIN';
    // SELECT, NEVER CLEAR. A wrong password stays in the field, highlighted, so
    // a typo is one keystroke to fix rather than a whole password to retype.
    $('pw').select();
    return;
  }
  // NO PASSWORD SET: the startup password is proved directly, since there is
  // nothing yet to hash it against. It buys the same session key.
  const r=await fetch('/api/state',{headers:{'x-lain-session':v}}).catch(()=>null);
  if(r&&r.ok){T=v;sessionStorage.setItem(KEY,T);unlock();draw(await r.json());return;}
  $('gatemsg').textContent=r?'that password was refused':'no answer from LAIN';
  $('pw').select();
});
async function post(action,value){
  const r=await fetch('/api/action',{method:'POST',headers:{...auth(),'content-type':'application/json'},body:JSON.stringify({action,value})});
  if(r.status===401){lock('that session is no longer valid');return;}
  const j=await r.json().catch(()=>({error:'no answer'}));
  $('msg').textContent=(j.did||j.error||'');
  tick();
}
function send(){
  const v=$('steer').value.trim();
  if(!v)return;
  $('steer').value='';
  post('steer',v);
}
$('send').addEventListener('click',send);
$('steer').addEventListener('keydown',(e)=>{if(e.key==='Enter')send();});
function thread(list){
  return list.map(m=>{
    if(m.who==='ACTION'){
      const mark=m.ok===false?'<span class="bad">✗</span>':'<span class="ok">✓</span>';
      return '<div class="msg ACTION"><div class="body">'+mark+' '+esc(m.text)+'</div></div>';
    }
    return '<div class="msg '+esc(m.who)+'"><div class="who">'+esc(m.who)+'</div><div class="body">'+esc(m.text)+'</div></div>';
  }).join('');
}
// ---- THE OTHER LAINS ------------------------------------------------------
//
// One chip per running instance, the current one marked. Switching is a LINK,
// not a proxy: it opens that instance's own dashboard, which asks for its own
// credential. Two LAINs stay exactly as separate as they are on the machine and
// their state is never merged into one view.
//
// Polled far less often than the state — instances start and stop on human
// timescales, and re-reading a directory four times a second to draw the same
// three chips is work for nothing.
let instShown=0;
async function instances(){
  const now=Date.now();
  if(now-instShown<10000)return;
  instShown=now;
  try{
    const r=await fetch('/api/instances',{headers:auth()});
    if(!r.ok)return;
    const list=(await r.json()).instances||[];
    // WITH ONLY THIS ONE RUNNING THERE IS NOTHING TO SWITCH BETWEEN, so the row
    // disappears rather than showing a single chip that does nothing.
    if(list.length<2){$('insts').innerHTML='';return;}
    $('insts').innerHTML=list.map(i=>{
      const label=esc(i.project||'lain')+(i.state&&i.state!=='READY'?' · '+esc(i.state):'');
      return i.self
        ? '<span class="here" title="'+esc(i.cwd)+'">'+label+'</span>'
        : '<a class="there" href="'+esc(i.url||'#')+'" title="'+esc(i.cwd)+'">'+label+'</a>';
    }).join('');
  }catch(e){/* the dashboard is still fine on its own */}
}

function draw(s){
  $('proj').textContent='LAIN · '+s.project.name;
  instances();
  $('task').textContent=s.task?s.task.objective:'no task yet';
  const el=$('thread');
  el.innerHTML=s.conversation&&s.conversation.length?thread(s.conversation):'<div class="msg"><div class="body dim">Nothing has been said yet.</div></div>';
  // Follow the conversation only while the reader is already at the bottom —
  // yanking the view down while somebody is reading back is the rudest thing a
  // live page can do.
  if(atBottom)el.scrollTop=el.scrollHeight;
  const p=s.phase;
  const prog=s.plan?(' <span class="dim">STEP '+s.plan.done+'/'+s.plan.total+'</span>'):'';
  $('live').innerHTML=p
    ?'<span class="'+(p.actor==='EXTERNAL'?'ext':'ok')+'">◒ '+esc(p.actor)+'</span> '+esc(p.phase)+(p.target?' <span class="dim">'+esc(p.target)+'</span>':'')+prog
    :(s.retry?'<span class="warn">◒ RATE LIMITED</span>'
      :(s.interrupted?'<span class="warn">■ INTERRUPTED</span>':'<span class="dim">○ idle</span>'+prog));
  const d=s.desktop;
  // THE HARNESS SECTION. Rendered from s.harness and from nothing else - the
  // page never derives a task state, a verdict or a health from prose.
  const H=s.harness;
  const hv=H&&H.verification;
  const hrows=H?(row('task',esc(H.task.state)+' <span class="dim">'+esc(H.task.title)+'</span>',
      H.task.state==='PASSED'?'ok':(H.task.state==='FAILED'?'bad':''))
    +row('proved',hv?(esc(hv.verdict)+' <span class="dim">'+hv.passed+'✓ '+hv.failed+'✗ '+hv.inconclusive+'?</span>'):'<span class="dim">nothing yet</span>',
      hv&&hv.verdict==='PASSED'?'ok':(hv&&hv.verdict==='FAILED'?'bad':''))
    +(H.processes.length?row('services',H.processes.map(function(x){return esc(x.name)+' '+esc(x.status)+' '+esc(x.health)+(x.port?' :'+x.port:'');}).join('<br>'),'dim'):'')
    +row('evidence',H.evidence.artifacts+' artifact(s) · '+H.evidence.events+' event(s)','dim')
    +(H.timeline.length?row('last',H.timeline.slice(-3).map(function(x){return esc(x.time)+' '+esc(x.text);}).join('<br>'),'dim'):'')):'';
  $('detail').innerHTML=hrows+row('model',esc(s.model.id||'none'))
    +row('route',esc([s.model.provider,s.model.connection].filter(Boolean).join(' · ')||'—'))
    +row('context',s.context.percent+'%')
    +(s.lifecycle?row('lifecycle',esc(s.lifecycle.state)):'')
    +(s.verification?row('last check',esc(s.verification.command),s.verification.ok?'ok':'bad'):'')
    +row('changed',s.changed.length?s.changed.map(f=>esc(f.path)).join('<br>'):'nothing','dim')
    +row('chat source',esc(s.chatSource.label)+(s.chatSource.model?' · '+esc(s.chatSource.model):(s.chatSource.web?' · no model chosen':'')),'dim')
    +row('mcp',d.state==='CONNECTED'?'<span class="ok">✓ CONNECTED</span>':'<span class="dim">'+esc(d.state)+'</span>')
    +(s.control.actions?'':row('control','read-only — /dash actions on','dim'));
  const on=s.control.actions;
  $('steer').disabled=!on;$('send').disabled=!on;
  if(!on)$('steer').placeholder='read-only — run /dash actions on';
}
async function tick(){
  if(!T){lock('');return;}
  try{
    const r=await fetch('/api/state',{headers:auth()});
    // A REVOKED SESSION RE-LOCKS THE PAGE. A LAIN that ended takes its session
    // keys with it, and a page left open must say so rather than sitting on the last
    // state it happened to have — a stale screen that looks live is worse than
    // an honest lock.
    if(r.status===401){lock('this session ended — LAIN printed a new startup password');return;}
    unlock();
    draw(await r.json());
  }
  catch(e){$('live').innerHTML='<span class="bad">✕ DISCONNECTED</span>';}
}
tick();setInterval(tick,1500);
</script></body></html>`;
}

module.exports = { page };
