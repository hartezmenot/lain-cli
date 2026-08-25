'use strict';

/**
 * MODEL SEARCH — split out of catalog.js because it is an ALGORITHM, not a
 * fact about routing. catalog.js answers "what models exist and how are they
 * reached"; this answers "which of them did the user mean".
 */
/**
 * SEARCH THE WAY PEOPLE TYPE.
 *
 * The old version tested ONE contiguous substring, so a query only matched when
 * its words happened to be adjacent, in that order, with that spacing. Measured
 * against the real 975-model catalog:
 *
 *   qwen free   →  0 results   (while `qwen3.8 27b Free` sat in the catalog)
 *   qwen 3.7    →  0 results   (while `qwen3.7 Flash` sat in the catalog)
 *   qwen3.7     →  9 results
 *
 * Nobody remembers a provider's exact punctuation. `qwen 3.7`, `qwen3.7` and
 * `QWEN 3.7` are the same question and must give the same answer.
 *
 * TWO NORMAL FORMS, both cheap and both computed from what is already in memory:
 *
 *   squashed  every non-alphanumeric character removed — `qwen3.7-27b-free`
 *             and `Qwen 3.7 27B Free` both become `qwen3727bfree`, which is
 *             what makes punctuation stop mattering.
 *   tokens    split on punctuation AND on letter↔digit boundaries, so
 *             `qwen3.8` yields `qwen · 3 · 8`. That is what lets `qwen free`
 *             find a name where the two words are separated by a version and a
 *             size.
 *
 * A multi-word query requires ALL its tokens (an AND, not an OR) — otherwise
 * `qwen free` degenerates into `qwen` and buries the one model that matched
 * both. If nothing satisfies the AND, it falls back to best-effort rather than
 * showing an empty screen, and says nothing false either way.
 *
 * Deterministic, local, zero tokens, no dependency.
 */

/** Everything about a model a person might type at it. */
function haystack(m) {
  const parts = [m.displayName, m.id];
  for (const c of m.connections || []) {
    parts.push(c.provider, c.connectionId, c.route, c.upstreamId);
    for (const u of Object.values(c.upstreamByEffort || {})) parts.push(u);
  }
  return parts.filter(Boolean).join(' ');
}

const squash = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '');

/** Split on punctuation and where letters meet digits: `qwen3.8` → qwen,3,8. */
function tokenize(s) {
  return String(s || '')
    .toLowerCase()
    .replace(/([a-z])(\d)/g, '$1 $2')
    .replace(/(\d)([a-z])/g, '$1 $2')
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
}

/**
 * How well does this model answer this query? Lower is better; -1 is no match.
 * Each tier is a statement about HOW the match was made, so any result can be
 * explained without trusting a score.
 */
function rankModel(m, qSquashed, qTokens) {
  const name = m.displayName.toLowerCase();
  const nameSquashed = squash(name);
  const idSquashed = squash(m.id);
  const nameTokens = tokenize(name);
  const allTokens = tokenize(haystack(m));

  if (nameSquashed === qSquashed || idSquashed === qSquashed) return 0;   // exact
  if (nameSquashed.startsWith(qSquashed)) return 1;                       // prefix
  if (nameSquashed.includes(qSquashed)) return 2;                         // contiguous, in the name
  if (idSquashed.includes(qSquashed)) return 3;                           // contiguous, in the id

  if (qTokens.every((t) => nameTokens.includes(t))) return 4;             // every word, in the name

  // A PREFIX OF A WORD, never a substring of one. `son` must still reach
  // `sonnet`; `7` must not reach `27`. Matching anywhere inside a token made
  // `qwen 3.7` return `qwen3.8 27b free` — the 7 of "27" satisfied it, so a
  // version query dragged in the neighbouring version.
  const prefixOf = (t, list) => list.some((x) => x.startsWith(t));
  if (qTokens.every((t) => prefixOf(t, nameTokens))) return 5;            // every word, by prefix
  if (qTokens.every((t) => prefixOf(t, allTokens))) return 6;            // every word, incl. provider
  return -1;
}

function search(catalog, query, limit = 60) {
  const raw = String(query || '').trim();
  const all = (catalog && catalog.models) || [];
  if (!raw) return all.slice(0, limit);

  const qSquashed = squash(raw);
  const qTokens = tokenize(raw);
  if (!qSquashed) return all.slice(0, limit);

  const scored = [];
  for (const m of all) {
    const r = rankModel(m, qSquashed, qTokens);
    if (r >= 0) scored.push({ m, r });
  }

  // NOTHING SATISFIED THE AND. Rather than an empty screen, offer what matched
  // most of the query — clearly ordered, so the near-misses are visibly that.
  if (!scored.length && qTokens.length > 1) {
    for (const m of all) {
      const toks = tokenize(haystack(m));
      const hit = qTokens.filter((t) => toks.includes(t)).length;
      if (hit) scored.push({ m, r: 10 - hit });
    }
  }

  return scored
    // A shorter name containing the same words is the more specific answer:
    // for `qwen 3.7`, `qwen3.7 Max` beats `qwen3.7 Max Thinking Preview`.
    .sort((a, b) => a.r - b.r
      || a.m.displayName.length - b.m.displayName.length
      || a.m.displayName.localeCompare(b.m.displayName))
    .slice(0, limit)
    .map((x) => x.m);
}


module.exports = { search, squash, tokenize, haystack, rankModel };
