'use strict';

/**
 * The network boundary. Everything above this file is protocol-agnostic.
 *
 * `chat()` is an async generator yielding a normalized event stream:
 *   { type:'text',       chunk }
 *   { type:'tool_calls', calls:[{id,name,input}] }
 *   { type:'usage',      inputTokens, outputTokens }   the receipt, once, at the end
 *   { type:'usage_live', inputTokens, outputTokens }   the input side, while it is still open
 *                        NEVER added to a total — see the note at message_start.
 *
 * Two wire protocols are implemented: Anthropic `/v1/messages` and the
 * OpenAI-compatible `/chat/completions`. A third "provider", `mock`, is selected
 * by LAIN_PROVIDER=mock and exists so the REAL binary can be smoke-tested
 * without credentials or token spend — it replaces this file's network call and
 * nothing else.
 *
 * PHASE 6 will add availability/connection routing on top. It is deliberately
 * absent here: the core loop must be correct before anything routes around it.
 */

const promptcache = require('./promptcache');
const errors = require('./errors');

const PROTOCOL = Object.freeze({ ANTHROPIC: 'anthropic', CHAT: 'chat', MOCK: 'mock' });

/**
 * Resolve which endpoint serves this turn.
 * Phase 1 keeps this deliberately small: env vars and explicit config only.
 * There is no catalog, no alias table and no 3,761-entry registry.
 */
function resolve(cfg = {}) {
  if (process.env.LAIN_PROVIDER === 'mock') {
    return { protocol: PROTOCOL.MOCK, provider: 'mock', connectionId: 'mock', model: cfg.model || 'mock-model', apiKey: 'mock', ctx: 200000, maxTokens: 4096 };
  }

  // STRUCTURED SELECTION: {model, connection, effort} resolved through the
  // catalog. The fused upstream id is produced HERE, at send time, and nowhere
  // else — which is the difference from V1, where the fused string WAS the
  // runtime identity and the catalog was only a render-time view.
  if (cfg.model && cfg.connections) {
    const connections = require('./connections').fromConfig(cfg, cfg._evidence || {});
    const catalog = require('./catalog').build(connections);
    const r = require('./catalog').resolve(catalog, {
      model: cfg.model, connectionId: cfg.connection, effort: cfg.effort,
    });
    if (r.ok) {
      // baseConnectionId is the configured connection; connectionId may carry a
      // routing namespace (e.g. `omniroute:openrouter`) that identifies the ROUTE.
      const conn = connections.find((c) => c.id === (r.connection.baseConnectionId || r.connection.connectionId));
      if (conn) {
        return {
          protocol: conn.protocol || PROTOCOL.CHAT,
          provider: conn.provider,
          connectionId: conn.id,
          model: r.upstreamId,
          canonicalModel: r.model,
          effort: r.effort,
          baseUrl: conn.baseUrl,
          apiKey: conn.apiKey || (conn.via === 'bridge' ? 'bridge' : ''),
          ctx: conn.ctx || 128000,
          maxTokens: conn.maxTokens || 4096,
          // CARRIED FROM THE CONFIG, because the SENDER needs it and only `resolve`
          // reads the config. `promptCache: true|false` overrides the guess in
          // src/promptcache.js for a gateway nobody here has seen.
          promptCache: cfg.promptCache,
          headers: conn.headers || {},
        };
      }
    }
  }

  // A `cfg.providers` branch stood here. Nothing in the codebase ever produced
  // that shape, and its connection id did not match the ids connections.js
  // reports — a second, silently divergent routing path. Removed: there is ONE
  // provider-routing implementation, and its ids are the ones /provider shows.

  // Env-var fallback, so a bare API key works with no config file.
  //
  // THE connectionId MUST MATCH connections.js. It did not, and the consequence
  // was a real control failure: availability was keyed 'anthropic' while
  // /provider listed the route as 'env:anthropic', so `/provider disable` set a
  // breaker nothing ever checked and the request went out regardless.
  if (process.env.ANTHROPIC_API_KEY) {
    return {
      protocol: PROTOCOL.ANTHROPIC, provider: 'anthropic', connectionId: 'env:anthropic',
      model: cfg.model || 'claude-opus-5',
      baseUrl: 'https://api.anthropic.com/v1',
      apiKey: process.env.ANTHROPIC_API_KEY,
      ctx: 200000, maxTokens: 8192, headers: {},
    };
  }
  if (process.env.OPENAI_API_KEY) {
    return {
      protocol: PROTOCOL.CHAT, provider: 'openai', connectionId: 'env:openai',
      model: cfg.model || 'gpt-5.5',
      baseUrl: 'https://api.openai.com/v1',
      apiKey: process.env.OPENAI_API_KEY,
      ctx: 128000, maxTokens: 8192, headers: {},
    };
  }
  return { protocol: null, provider: null, connectionId: null, model: cfg.model || null, apiKey: '' };
}

/**
 * A setup instruction, not a crash, and it costs zero requests.
 *
 * `cfg` is optional and only used to tell three genuinely different situations
 * apart. They were previously collapsed into "No provider configured", which
 * sent a user with a working, reachable, already-authenticated bridge off to
 * find an API key they did not need.
 */
function credentialHint(pc, cfg = null) {
  if (!pc.protocol) {
    const hasConnections = cfg && cfg.connections && Object.keys(cfg.connections).length > 0;
    if (hasConnections && !cfg.model) {
      return 'No model selected. /model to browse what your connections serve, or /model <name>.';
    }
    if (hasConnections && cfg.model) {
      return `Model "${cfg.model}" is not served by any configured connection. /model to pick one, or /provider refresh to re-read a route's catalog.`;
    }
    return 'No provider configured. Set ANTHROPIC_API_KEY or OPENAI_API_KEY, or declare a connection in ~/.lain-v2/config.json.';
  }
  if (!pc.apiKey) return `No credential for provider '${pc.provider}'.`;
  return null;
}

// ---------------------------------------------------------------- http ------

/**
 * TIMEOUTS. Without these the CLI hangs forever on a bridge that accepts the
 * TCP connection and then never answers — verified: 45s with no prompt back and
 * no error, killed externally. "Unreachable" is a fast failure; "accepted and
 * silent" was an unbounded one, and the second is the common shape of a wedged
 * local router.
 */
/**
 * TIME TO FIRST BYTE was 30s, and that is a real model's ordinary behaviour.
 *
 * Found by driving the binary against a provider that answers after exactly 30
 * seconds: LAIN killed the request and reported the provider as not answering,
 * one instant before the answer arrived. A reasoning model can think for a
 * minute before it emits a token, and extended-thinking requests routinely do —
 * so the old bound turned "slow" into "broken" for exactly the models people
 * reach for on hard problems.
 *
 * What makes a long bound safe is that the wait is VISIBLE: the header says
 * THINKING, the elapsed counter ticks every second, and Ctrl+C lands
 * immediately. The user is never guessing, so LAIN does not need to guess on
 * their behalf. The bound still exists, because a wedged local router accepts
 * the connection and then says nothing forever.
 *
 * ------------------------------------------------------------------------
 * THEN 120s WAS TOO SHORT TOO, and for the same reason twice over.
 *
 * Reported from real use: "time run out after LLM not responding for 120s".
 * Two minutes is an ordinary amount of thinking for a large reasoning model on
 * a hard problem, and it is nothing at all for one behind a local router that
 * is loading weights, queueing behind another request, or paging a long context
 * back in. Every one of those is a HEALTHY provider, and every one of them was
 * being reported as a dead one.
 *
 * The argument above is the argument for raising it again: the bound is not
 * what protects the user — the visible wait and a working Ctrl+C are. The bound
 * exists solely so that a socket which will NEVER answer does not hold a
 * session open until somebody notices. Ten minutes serves that and stops
 * punishing the models people reach for when the problem is hard.
 *
 * WHY NOT A HEARTBEAT INSTEAD. It is the obvious idea and it does not work
 * here: nothing in the protocol distinguishes a provider that is thinking from
 * one that is wedged. Neither sends anything. Some send SSE comments and most
 * do not, so a keepalive check would be a bound that varies with the vendor —
 * a longer, honest, single number is better than a mechanism that silently
 * means different things on different routes.
 */
const TTFB_TIMEOUT_MS = Number(process.env.LAIN_TTFB_TIMEOUT_MS) || 600_000;
const INACTIVITY_TIMEOUT_MS = Number(process.env.LAIN_STREAM_TIMEOUT_MS) || 60_000;

/**
 * Compose the caller's abort signal with a deadline. Returns the signal to pass
 * to fetch plus a `timedOut` flag so a deadline can be told apart from the user
 * pressing Esc — they are different outcomes and must classify differently.
 */
function deadline(signal, ms) {
  const ac = new AbortController();
  const state = { timedOut: false };
  const onAbort = () => ac.abort();
  if (signal) {
    if (signal.aborted) ac.abort();
    else signal.addEventListener('abort', onAbort, { once: true });
  }
  const timer = setTimeout(() => { state.timedOut = true; ac.abort(); }, ms);
  state.signal = ac.signal;
  state.clear = () => {
    clearTimeout(timer);
    if (signal) signal.removeEventListener('abort', onAbort);
  };
  return state;
}

async function postSSE(url, headers, body, signal) {
  const d = deadline(signal, TTFB_TIMEOUT_MS);
  let res;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      body: JSON.stringify(body),
      signal: d.signal,
    });
  } catch (e) {
    if (d.timedOut) {
      const err = new Error(`no response headers within ${Math.round(TTFB_TIMEOUT_MS / 1000)}s`);
      err.timedOut = true;
      // NOT RETRIABLE, deliberately. A server that never sent response headers
      // is not stalling mid-stream — it is not answering at all, and retrying
      // multiplies the wait by the retry count (30s x 3 = a 92s freeze, measured).
      // Fail fast so the breaker takes over and the prompt comes straight back.
      err.noResponse = true;
      throw err;
    }
    throw e;
  } finally {
    d.clear();
  }
  if (!res.ok) {
    let detail = '';
    try { detail = (await res.text()).slice(0, 600); } catch { /* body already consumed */ }
    const err = new Error(`${res.status} ${res.statusText}${detail ? ' — ' + detail : ''}`);
    err.status = res.status;
    const ra = res.headers.get('retry-after');
    if (ra) err.retryAfter = Number(ra);
    throw err;
  }
  return res;
}

/**
 * Yield complete SSE `data:` payloads from a fetch Response.
 *
 * The read is raced against an inactivity deadline: headers arriving is not a
 * promise that bytes will follow, and a stream that goes quiet mid-turn is the
 * other way a wedged bridge hangs the prompt.
 */
async function* sseLines(res, signal = null) {
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  while (true) {
    // ---- CTRL+C MUST REACH THE SOCKET, NOT JUST THE SCREEN ----------------
    //
    // THE MEASURED DEFECT: the caller's signal was wired to `fetch` and to
    // nothing else, and `postSSE` removes its abort listener in a `finally` the
    // moment response headers arrive. From that instant the user's Ctrl+C was
    // connected to nothing at all. This loop then read the body to its natural
    // end — or sat until the 60s inactivity deadline — while the screen said
    // INTERRUPTING. That is the "I press Ctrl+C and it stays INTERRUPTING for
    // an excessive amount of time" report, exactly.
    //
    // Racing the read against the abort is not enough by itself: an unresolved
    // `reader.read()` holds the socket open. `reader.cancel()` is what actually
    // tears the response down, and it runs before this throws.
    if (signal && signal.aborted) {
      try { await reader.cancel(); } catch { /* already gone */ }
      const e = new Error('cancelled');
      e.aborted = true;
      throw e;
    }
    let timer;
    const stall = new Promise((_, reject) => {
      timer = setTimeout(() => {
        const e = new Error(`stream inactive for ${Math.round(INACTIVITY_TIMEOUT_MS / 1000)}s`);
        e.timedOut = true;
        reject(e);
      }, INACTIVITY_TIMEOUT_MS);
    });
    // The abort must be a RACER, not only a check at the top of the loop: a
    // stream that has gone quiet is precisely when somebody reaches for Ctrl+C,
    // and a check between chunks waits for a chunk that is never coming.
    let onAbort = null;
    const cancelled = new Promise((_, reject) => {
      if (!signal) return;
      onAbort = () => { const e = new Error('cancelled'); e.aborted = true; reject(e); };
      signal.addEventListener('abort', onAbort, { once: true });
    });
    let chunk;
    try {
      chunk = await Promise.race([reader.read(), stall, cancelled]);
    } catch (e) {
      // WHATEVER ENDED THE WAIT, the socket is released before the error leaves.
      // A timeout that abandoned an open response would leak it for the life of
      // the process.
      try { await reader.cancel(); } catch { /* already gone */ }
      throw e;
    } finally {
      clearTimeout(timer);
      if (signal && onAbort) signal.removeEventListener('abort', onAbort);
    }
    const { done, value } = chunk;
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    let nl;
    while ((nl = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (!line.startsWith('data:')) continue;
      const payload = line.slice(5).trim();
      if (!payload || payload === '[DONE]') continue;
      try { yield JSON.parse(payload); } catch { /* keepalive or partial */ }
    }
  }
}

// ----------------------------------------------------------- anthropic ------

function toAnthropic(messages) {
  const system = [];
  const out = [];
  for (const m of messages) {
    if (!m) continue;
    if (m.role === 'system') { system.push(String(m.content || '')); continue; }
    if (m.role === 'tool') {
      const block = { type: 'tool_result', tool_use_id: String(m.tool_call_id || ''), content: String(m.content || '') };
      if (m.isError) block.is_error = true;
      // Parallel results belong in ONE user message; a bare user turn between
      // them is a 400.
      const prev = out[out.length - 1];
      const isResultTurn = prev && prev.role === 'user' && Array.isArray(prev.content)
        && prev.content.length && prev.content.every((p) => p.type === 'tool_result');
      if (isResultTurn) prev.content.push(block);
      else out.push({ role: 'user', content: [block] });
      continue;
    }
    if (m.role === 'assistant' && Array.isArray(m.tool_calls) && m.tool_calls.length) {
      const content = [];
      if (String(m.content || '').trim()) content.push({ type: 'text', text: m.content });
      for (const tc of m.tool_calls) {
        let input = {};
        try { input = typeof tc.arguments === 'string' ? JSON.parse(tc.arguments || '{}') : (tc.arguments || {}); } catch { input = {}; }
        content.push({ type: 'tool_use', id: String(tc.id), name: String(tc.name), input });
      }
      out.push({ role: 'assistant', content });
      continue;
    }
    // ---- NEVER TWO USER TURNS IN A ROW ----------------------------------
    //
    // The runtime-state block rides at the tail of the wire, and the message
    // before it is very often a tool result — which this mapping has already
    // turned into a user turn carrying `tool_result` blocks. Pushing a second
    // user message there is a 400 on this protocol, so the text joins the turn
    // that is already open.
    const prev = out[out.length - 1];
    if (m.role === 'user' && prev && prev.role === 'user' && Array.isArray(prev.content)) {
      prev.content.push({ type: 'text', text: String(m.content || '') });
      continue;
    }
    out.push({ role: m.role, content: String(m.content || '') });
  }
  return { system: system.join('\n\n'), messages: out };
}

/**
 * MARK ONE MESSAGE AS A CACHE BOUNDARY.
 *
 * `cache_control` can only sit on a content BLOCK, never on a bare string, so a
 * plain-text message is lifted into the one-block array form it needs to carry
 * the marker. Anthropic caches everything up to and including a marked block as
 * one prefix, silently ignoring the marker on a block too small to be worth
 * caching — so this is never wrong to add, only sometimes free of effect.
 */
function withCacheBreakpoint(msg) {
  if (!msg) return msg;
  if (Array.isArray(msg.content)) {
    if (!msg.content.length) return msg;
    const content = msg.content.slice();
    content[content.length - 1] = { ...content[content.length - 1], cache_control: { type: 'ephemeral' } };
    return { ...msg, content };
  }
  if (typeof msg.content === 'string' && msg.content) {
    return { ...msg, content: [{ type: 'text', text: msg.content, cache_control: { type: 'ephemeral' } }] };
  }
  return msg;
}

async function* anthropicChat(pc, messages, opts) {
  const { system, messages: rawBody } = toAnthropic(messages);
  // ---- THE MOVING CACHE BREAKPOINT ------------------------------------------
  //
  // The turn loop resends the FULL accumulated message array on every single
  // step (turn.js), and `session.messages` only ever grows within a turn: a
  // step appends the model's tool call and the tool's result, never rewrites
  // what came before. Without a breakpoint here, that growing array was
  // transmitted and billed as fully uncached input on every step — for an
  // N-step turn, the uncached total grows like N(N+1)/2 instead of N, which is
  // exactly the shape of a 50-80x token blowup on a tool-heavy turn.
  //
  // Marking the LAST message as the boundary fixes it structurally: request
  // N+1's array is request N's array with new messages appended, so the bytes
  // up to request N's boundary are unchanged, and Anthropic's cache lookup
  // walks backward from wherever THIS request's breakpoint sits to find the
  // longest previously-cached prefix — it does not require the earlier
  // request to have marked that same position, only that the content match.
  // ONE breakpoint is deliberate: a second one further back only pays off if
  // it lands on a position some earlier request also marked, which a variable
  // per-step growth (single vs parallel tool calls) cannot guarantee, so a
  // stray second marker would just spend one of the 4 per-request breakpoints
  // for no reliable gain.
  let body = rawBody;
  if (body.length) {
    body = body.slice();
    body[body.length - 1] = withCacheBreakpoint(body[body.length - 1]);
  }
  const payload = { model: pc.model, max_tokens: pc.maxTokens, stream: true, messages: body };
  if (system) {
    // Cache the whole stable prefix. Anthropic orders tools -> system ->
    // messages, so one breakpoint on system covers the tool schemas too. Always
    // attempted, not gated on length: a block too small to be worth caching is
    // silently left uncached rather than rejected, so there is no downside to
    // marking it every time instead of guessing a size threshold.
    payload.system = [{ type: 'text', text: system, cache_control: { type: 'ephemeral' } }];
  }
  if (opts.tools && opts.tools.length) {
    payload.tools = opts.tools.map((t, i) => {
      const def = {
        name: t.name, description: t.description,
        input_schema: t.parameters || { type: 'object', properties: {} },
      };
      // Tool schemas are the same object on every step of every turn — the
      // single most stable part of the request — so the last one carries the
      // boundary that caches the whole tools block.
      if (i === opts.tools.length - 1) def.cache_control = { type: 'ephemeral' };
      return def;
    });
  }
  const res = await postSSE(`${pc.baseUrl}/messages`, {
    'x-api-key': pc.apiKey,
    'anthropic-version': '2023-06-01',
    ...pc.headers,
  }, payload, opts.signal);

  const acc = [];
  // cacheReadTokens/cacheCreationTokens are the diagnostic that answers "is the
  // cache actually working": a healthy tool-heavy turn should show cache reads
  // climbing step over step while input tokens (the uncached remainder) stay
  // small and roughly flat, rather than growing with the conversation.
  let usage = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0 };
  for await (const j of sseLines(res, opts.signal)) {
    if (j.type === 'content_block_start' && j.content_block && j.content_block.type === 'tool_use') {
      acc[j.index || 0] = { id: j.content_block.id, name: j.content_block.name, args: '' };
    } else if (j.type === 'content_block_delta' && j.delta) {
      if (j.delta.text) yield { type: 'text', chunk: j.delta.text };
      if (j.delta.type === 'input_json_delta' && acc[j.index || 0]) acc[j.index || 0].args += j.delta.partial_json || '';
    } else if (j.type === 'message_start' && j.message && j.message.usage) {
      const u = j.message.usage;
      usage.inputTokens = u.input_tokens || 0;
      usage.cacheReadTokens = u.cache_read_input_tokens || 0;
      usage.cacheCreationTokens = u.cache_creation_input_tokens || 0;
      // ---- THE ONLY GENUINELY LIVE NUMBER IN A REQUEST --------------------
      //
      // The input side is complete HERE, at the first frame, before a single
      // output token exists — the model cannot read more of the prompt later.
      // So it can be shown while the request is still open, and it is the half
      // a person actually wants during the wait: "what did this turn cost me
      // to ask" is answerable now and "what did it cost to answer" is not.
      //
      // A SEPARATE EVENT TYPE, never an early `usage`. `usage` is the receipt
      // and turn.js ADDS it to the record; emitting one here would double every
      // request's input tokens the moment the real one arrived.
      yield { type: 'usage_live', ...usage };
    } else if (j.type === 'message_delta' && j.usage) {
      usage.outputTokens = j.usage.output_tokens || usage.outputTokens;
    }
  }
  const calls = acc.filter(Boolean).map((t) => {
    let input = {};
    try { input = t.args.trim() ? JSON.parse(t.args) : {}; } catch { input = {}; }
    return { id: t.id, name: t.name, input };
  });
  if (calls.length) yield { type: 'tool_calls', calls };
  yield { type: 'usage', ...usage };
}

// ---------------------------------------------------------------- chat ------

async function* openaiChat(pc, messages, opts) {
  const wire = messages.map((m) => {
    if (m.role === 'tool') return { role: 'tool', tool_call_id: m.tool_call_id, content: String(m.content || '') };
    if (m.role === 'assistant' && Array.isArray(m.tool_calls) && m.tool_calls.length) {
      return {
        role: 'assistant', content: m.content || null,
        tool_calls: m.tool_calls.map((tc) => ({
          id: tc.id, type: 'function',
          function: { name: tc.name, arguments: typeof tc.arguments === 'string' ? tc.arguments : JSON.stringify(tc.arguments || {}) },
        })),
      };
    }
    return { role: m.role, content: String(m.content || '') };
  });
  // ---- THE REPLAYED TRANSCRIPT, MADE CACHEABLE ---------------------------
  //
  // The anthropic path above places a moving cache breakpoint and explains at
  // length why: without one, an N-step turn is billed N(N+1)/2 instead of N.
  // This path had none, so every OpenAI-shaped route — which is what a bridge
  // or gateway is — paid that blowup in full. Measured before this line
  // existed: ten files, 236,711 chars on disk, 1,563,325 chars transmitted.
  //
  // Applied only where the marker is both needed and understood; see
  // src/promptcache.js for which routes those are and why it is not simply
  // sent everywhere.
  const cacheable = promptcache.needsExplicitCache(pc, (opts && opts.cfg) || {});
  const body = cacheable ? promptcache.applyToChat(wire) : wire;
  const payload = { model: pc.model, messages: body, stream: true, stream_options: { include_usage: true } };
  if (opts.tools && opts.tools.length) {
    payload.tools = opts.tools.map((t) => ({ type: 'function', function: { name: t.name, description: t.description, parameters: t.parameters } }));
  }
  const res = await postSSE(`${pc.baseUrl}/chat/completions`, {
    authorization: `Bearer ${pc.apiKey}`, ...pc.headers,
  }, payload, opts.signal);

  const acc = [];
  let usage = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0 };
  for await (const j of sseLines(res, opts.signal)) {
    if (j.usage) {
      const before = usage.inputTokens;
      usage.inputTokens = j.usage.prompt_tokens || usage.inputTokens;
      usage.outputTokens = j.usage.completion_tokens || usage.outputTokens;
      // WITHOUT THIS, WHETHER CACHING WORKS IS UNANSWERABLE FROM INSIDE LAIN.
      // A saving nobody can measure is one nobody can defend, and a regression
      // in it is invisible. See promptcache.usageFrom for the spellings.
      const c = promptcache.usageFrom(j.usage);
      usage.cacheReadTokens = c.cacheReadTokens || usage.cacheReadTokens || 0;
      usage.cacheCreationTokens = c.cacheCreationTokens || usage.cacheCreationTokens || 0;
      // ---- LIVE ONLY IF IT GENUINELY ARRIVED EARLY ------------------------
      //
      // This shape has no `message_start`, so there is no guaranteed moment at
      // which the input side is known: with `include_usage` most gateways state
      // it once, in the FINAL chunk, and a few state it as they go. Emitted
      // when the number first appears, whenever that is — which on most routes
      // means a live figure lands a beat before the receipt and on some means
      // there was never one to show.
      //
      // That is the honest behaviour and it is why nothing here interpolates:
      // §10 asks for what is live to be live and what is not to be absent, not
      // for every provider to be made to look the same.
      if (usage.inputTokens && usage.inputTokens !== before) yield { type: 'usage_live', ...usage };
    }
    const d = j.choices && j.choices[0] && j.choices[0].delta;
    if (!d) continue;
    if (d.content) yield { type: 'text', chunk: d.content };
    // ---- A REASONING MODEL MAY PUT EVERYTHING SOMEWHERE ELSE -------------
    //
    // Observed in a live session: `stealth/ox-alpha` through omniroute was
    // asked "hello" and Context was EMPTY — the task banner, then nothing,
    // then DONE. The turn succeeded, the request succeeded, and the screen had
    // nothing on it.
    //
    // This parser only ever read `d.content`. Reasoning models behind
    // OpenRouter-shaped gateways stream their prose as `reasoning` or
    // `reasoning_content`, and some emit ONLY that — so every word the model
    // produced was parsed, dropped, and reported as a successful empty turn.
    //
    // KEPT AS ITS OWN EVENT, never merged into `text`. Reasoning is the model
    // thinking aloud; content is its answer. Concatenating them would put
    // working-out into the transcript as though it had been said, and
    // `record.text` is what the completion check and the session projection
    // read. The screen shows it dimmed — a fallback for a pane that would
    // otherwise be blank, not a promotion of thinking to speech.
    const think = d.reasoning_content || d.reasoning;
    if (think) yield { type: 'reasoning', chunk: String(think) };
    for (const tc of d.tool_calls || []) {
      const i = tc.index || 0;
      if (!acc[i]) acc[i] = { id: tc.id || `call_${i}`, name: '', args: '' };
      if (tc.id) acc[i].id = tc.id;
      if (tc.function && tc.function.name) acc[i].name += tc.function.name;
      if (tc.function && tc.function.arguments) acc[i].args += tc.function.arguments;
    }
  }
  const calls = acc.filter((t) => t && t.name).map((t) => {
    let input = {};
    try { input = t.args.trim() ? JSON.parse(t.args) : {}; } catch { input = {}; }
    return { id: t.id, name: t.name, input };
  });
  if (calls.length) yield { type: 'tool_calls', calls };
  yield { type: 'usage', ...usage };
}

// ---------------------------------------------------------------- entry -----

/**
 * ONE FUNNEL, AND EVERY REQUEST THROUGH IT IS RECORDED.
 *
 * This is the only place in the program where a conversation is sent to a
 * model — turn.js for the agent loop, external.js for a second opinion, and
 * nothing else. That makes it the one honest place to answer "how many requests
 * did that turn cost, and why": a ledger anywhere higher would be a second
 * count that can disagree with the wire, and one anywhere lower would be per
 * protocol and would have to be written twice.
 *
 * `opts.trace` is what the CALLER knows and this cannot infer — which turn,
 * which step, and why it is asking. See reqtrace.js. Measuring only; it cannot
 * change, delay or retry anything, and a tracer that throws would be a
 * measurement able to end a turn.
 */
async function* chat(pc, messages, opts = {}) {
  const reqtrace = require('./reqtrace');
  const rec = reqtrace.begin({
    ...(opts.trace || {}),
    model: pc.model || '',
    connection: pc.connectionId || pc.provider || '',
  });
  // THE RECEIPT THIS ATTEMPT RETURNED, or null — the last `usage` event the
  // provider streamed. Captured here because this is the one funnel every
  // protocol passes through, and given to the ledger so it can ride the
  // per-request record (`reqtrace.end`). Events are yielded through UNCHANGED:
  // capturing is observing, and nothing downstream may see a difference.
  let receipt = null;
  try {
    const inner = pc.protocol === PROTOCOL.MOCK
      ? require('./mockprovider').chat(pc, messages, opts)
      : pc.protocol === PROTOCOL.ANTHROPIC
        ? anthropicChat(pc, messages, opts)
        : pc.protocol === PROTOCOL.CHAT
          ? openaiChat(pc, messages, opts)
          : null;
    if (!inner) {
      const e = new Error(`no protocol for provider '${pc.provider}'`);
      e.status = 400;
      throw e;
    }
    for await (const ev of inner) {
      if (ev && ev.type === 'usage') receipt = ev;
      yield ev;
    }
    reqtrace.end(rec, { ok: true, receipt });
  } catch (e) {
    reqtrace.end(rec, { ok: false, status: e && e.status, failure: (e && e.message) || 'failed', receipt });
    throw e;
  }
}

// `sseLines` is exported as a TEST SEAM, and for one specific question: does
// a Ctrl+C reach the socket while a stream is open? That is measurable here
// with a fake body and unmeasurable anywhere above, because every layer
// above reports the same INTERRUPTING whether the read stopped or not.
// `toAnthropic` is exported for ONE assertion: that the runtime-state block at
// the tail of the wire never produces two consecutive user turns, which this
// protocol refuses with a 400. The alternative was a test that skipped itself
// when the symbol was missing — a guarantee that quietly stops being checked.
module.exports = { PROTOCOL, resolve, chat, credentialHint, classify: errors.classify, sseLines, toAnthropic };
