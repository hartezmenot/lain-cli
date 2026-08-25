'use strict';

/**
 * THE CAPABILITY PROBE SET — what /compare knows how to look for.
 *
 * Split out of compare.js because it is a TABLE, not an engine: adding a
 * capability should be adding a row, never touching the comparison logic. The
 * engine runs whatever is here, symmetrically, over both trees.
 */
/**
 * THE PROBE SET.
 *
 * `paths` matches file names; `content` matches inside readable files. A
 * capability needs ONE hit to be present — these are deliberately specific, on
 * the grounds that a false "yes, you already have this" is the expensive error:
 * it hides a real gap.
 *
 * `replacedBy` names the mechanism that satisfies the capability differently.
 * When the left side has the capability and the right side has only the
 * replacement, the row reads REPLACED rather than MISSING — that distinction is
 * the entire value of the report.
 *
 * `plain` is the sentence shown to a person. It says what the capability DOES,
 * with no vocabulary that assumes you have read the source.
 */
const CAPABILITIES = [
  {
    id: 'project-scan', name: 'Project scanner', group: 'Understanding',
    plain: 'Works out what kind of project this is — languages, how to run it, where the code lives — before asking the model anything.',
    paths: [/(^|\/)(discovery|project)\.js$/],
    content: [/function (scan|brief)\s*\(/],
  },
  {
    id: 'structural-search', name: 'Structural search', group: 'Understanding',
    plain: 'Finds where a name is defined and who uses it, without reading whole files.',
    paths: [/(^|\/)(search|locate)\.[jp][sy]$/, /tools\/(index|locate|imports|deps)\.py$/, /(^|\/)tools\.js$/],
    content: [/read_symbol|indexQuery|find_symbol|\bsymbols\b|locate/i],
  },
  {
    id: 'ast-index', name: 'AST index', group: 'Understanding',
    plain: 'A real language parser building a symbol table for the whole project.',
    paths: [/tools\/index\.py$/, /(^|\/)fgmlang\.js$/],
    replacedBy: { id: 'structural-search', why: 'text-shaped structural search that reads the files as they are now, with no index to go stale and no Python needed' },
  },
  {
    id: 'dependency-graph', name: 'Dependency graph (FGM)', group: 'Understanding',
    plain: 'Answers "what else depends on this file, and what would break if I change it".',
    paths: [/(^|\/)fgm\.js$/],
    replacedBy: { id: 'dependents', why: 'the same question answered on demand from the current tree, instead of from a stored graph rebuilt at startup' },
  },
  {
    id: 'dependents', name: 'File dependents (live)', group: 'Understanding',
    plain: 'Lists every file that imports or links to a given file, computed fresh each time.',
    paths: [/tools\/search\.js$/],
    content: [/tools\.dependents\s*=/],
  },
  {
    id: 'project-notes', name: 'Project notes / init', group: 'Understanding',
    plain: 'Saves a short written summary of the project so later sessions do not have to work it out again.',
    paths: [/(^|\/)project-context\.js$/],
    content: [/\.lain\/summary\.md|\.lain\/architecture\.md/],
  },
  {
    id: 'dictionary', name: 'Cross-language vocabulary', group: 'Understanding',
    plain: 'Ties the same name in different languages together — a button in the page and its handler on the server.',
    paths: [/(^|\/)dictionary\.js$/],
  },

  {
    id: 'context-management', name: 'Context window management', group: 'Efficiency',
    plain: 'Keeps the conversation small enough that the provider will still accept it on a long task.',
    paths: [/(^|\/)(session|repl|commands|turn)\.js$/],
    content: [/'\/compact'|"\/compact"|compactMessages|budgetChars/],
  },
  {
    id: 'evidence-cache', name: 'Read cache', group: 'Efficiency',
    plain: 'Remembers which files are already in the conversation, so the same unchanged file is not sent twice.',
    paths: [/(^|\/)evidence\.js$/, /(^|\/)reads\.js$/],
    content: [/EvidenceLedger|already inspected/i],
  },
  {
    id: 'claim-classification', name: 'Claim classification', group: 'Evidence',
    plain: 'Separates things that were actually observed from things the model merely asserted.',
    paths: [/(^|\/)evidence\.js$/],
    content: [/HYPOTHESIS|MODEL_CLAIM/],
  },
  {
    id: 'cost-accounting', name: 'Token / cost accounting', group: 'Efficiency',
    plain: 'Records what each request cost, so spend can be compared over time.',
    paths: [/(^|\/)(track|pricing|usage)\.js$/],
    content: [/costOf|costFor|pricePer|\busd\b/i],
  },

  {
    id: 'completion-gate', name: 'Completion gate', group: 'Correctness',
    plain: 'Refuses to call a task finished just because the model said so — it wants a check that actually passed.',
    paths: [/(^|\/)(lifecycle|goalcheck|review|verification)\.js$/],
    content: [/no completion evidence|acceptance_criteria|function complete\s*\(/],
  },
  {
    id: 'claim-check', name: 'Success-claim check', group: 'Correctness',
    plain: 'Notices when the model says the tests pass but the last command actually failed.',
    paths: [/(^|\/)lifecycle\.js$/],
    content: [/contradiction\s*\(/],
  },
  {
    id: 'liveness', name: 'No-progress detection', group: 'Correctness',
    plain: 'Notices when the model keeps doing the same thing and getting the same answer, and tells YOU — without interrupting it or writing to it.',
    paths: [/(^|\/)(liveness|lifecycle|tasklifecycle|looping)\.js$/],
    content: [/no new evidence|repeated narration|NUDGE|STILL GOING ROUND/],
  },
  {
    id: 'diff-scope', name: 'Change-scope check', group: 'Correctness',
    plain: 'Compares what actually changed on disk against what was supposed to change.',
    paths: [/(^|\/)diffguard\.js$/],
    content: [/SCOPE_VIOLATION/],
  },
  {
    id: 'static-check', name: 'Static site verifier', group: 'Correctness',
    plain: 'Checks that a plain HTML/CSS/JS site actually hangs together when there are no tests to run.',
    paths: [/(^|\/)staticcheck\.js$/],
  },
  {
    id: 'code-hygiene', name: 'Leftover-scaffolding check', group: 'Correctness',
    plain: 'Finds debug prints and throwaway code left behind after a fix.',
    paths: [/(^|\/)codehygiene\.js$/],
    replacedBy: { id: 'prompt-rule', why: 'a standing instruction in the system prompt to remove scaffolding before reporting' },
  },
  { id: 'prompt-rule', name: 'Workflow guidance', group: 'Workflow',
    plain: 'Tells the model how to approach this KIND of request — implement, bugfix, audit, and so on.',
    paths: [/(^|\/)(prompt|persona|instructions)\.js$/],
  },
  {
    id: 'request-mode', name: 'Request classification', group: 'Workflow',
    plain: 'Works out locally whether you are asking for a fix, a feature, an audit or an explanation.',
    paths: [/(^|\/)(mode|diagnostic|task)\.js$/],
    content: [/TROUBLESHOOT|NEW_PROJECT/],
  },
  {
    id: 'plans', name: 'Plans', group: 'Workflow',
    plain: 'A short checklist of steps, ticked off as they are genuinely done.',
    paths: [/(^|\/)plan\.js$/],
  },
  {
    id: 'worklog', name: 'Mid-step scratchpad', group: 'Workflow',
    plain: 'Notes how far into a step the work got, so a reset does not restart the step.',
    paths: [/(^|\/)(worklog|drafts)\.js$/],
  },

  {
    id: 'checkpoint-undo', name: 'Checkpoint / undo', group: 'Safety',
    plain: 'Keeps the previous contents of every file it edits, so a change can be taken back.',
    paths: [/(^|\/)checkpoint\.js$/],
  },
  {
    id: 'fingerprint', name: 'Change detection', group: 'Safety',
    plain: 'Notices when a file was changed by something else, so an undo cannot silently discard it.',
    paths: [/(^|\/)(checkpoint|evidence|drafts)\.js$/],
    content: [/sha256|createHash/],
  },
  {
    id: 'permissions', name: 'Tool permission gate', group: 'Safety',
    plain: 'Asks before letting the model run certain commands.',
    paths: [/(^|\/)permissions\.js$/],
    excluded: 'Dropped on purpose: a gate that is always approved teaches you to approve without reading. Reversibility (checkpoint/undo) is the safety mechanism instead.',
  },

  {
    id: 'session-resume', name: 'Sessions and resume', group: 'State',
    plain: 'Saves the conversation and lets you pick a specific one up again later.',
    paths: [/(^|\/)(session|repl|commands)\.js$/],
    content: [/'\/resume'|"\/resume"|static resume|resumeSession/],
  },
  {
    id: 'cross-run-learning', name: 'Cross-run learning', group: 'State',
    plain: 'Remembers what worked last time — which fix cleared an error, how a kind of thing gets built — so a similar task later starts warm instead of cold.',
    paths: [/(^|\/)(recipeledger|fixledger|knowledge|memory|skills)\.js$/],
  },
  {
    id: 'handoff', name: 'Cross-model handoff', group: 'State',
    plain: 'Writes down what one model established so a different model does not have to rediscover it.',
    paths: [/(^|\/)handoff\.js$/],
    excluded: 'Only useful with several models working one task. That is the orchestra, which is a separate project and deliberately not part of this one.',
  },

  {
    id: 'model-catalog', name: 'Model discovery', group: 'Providers',
    plain: 'Asks a provider what models it serves instead of you typing the list out.',
    paths: [/(^|\/)(catalog|connections|modelcatalog)\.js$/],
  },
  {
    id: 'model-refresh', name: 'Live catalog refresh', group: 'Providers',
    plain: 'Picks up a model you added elsewhere without restarting.',
    paths: [/(^|\/)(catalog|commands|repl|modelcatalog)\.js$/],
    content: [/refresh(Catalog|Models|Connections)\s*\(|(models?|api) refresh/i],
  },
  {
    id: 'provider-health', name: 'Provider health', group: 'Providers',
    plain: 'Knows which routes are answering and stops hammering one that is down.',
    paths: [/(^|\/)(availability|modelhealth|health|providerstate)\.js$/],
  },
  {
    id: 'oauth', name: 'OAuth login', group: 'Providers',
    plain: 'Signs in to a provider through a browser instead of pasting a key.',
    paths: [/(^|\/)(oauth|googleauth|dashauth|connections|commands|repl)\.js$/],
    content: [/oauth/i],
  },
  {
    id: 'orchestra', name: 'Multi-model orchestra', group: 'Providers',
    plain: 'Several models with different jobs working on one task together.',
    paths: [/(^|\/)(orchestra|agents|relay|council)\.js$/],
    excluded: 'A separate project (lain-model). This one is a standalone CLI and talks to a configured provider; it does not host an orchestra.',
  },
  {
    id: 'dashboard', name: 'Web dashboard', group: 'Providers',
    plain: 'A browser page showing what the CLI is doing.',
    paths: [/(^|\/)(webdash|dashboard|idebridge|zed|cline|kiro)\.js$/],
    excluded: 'A second interface to keep in step with the first. The terminal UI is the product.',
  },

  {
    id: 'diagnostics', name: 'Environment check', group: 'Operability',
    plain: 'Tells you why it is not working — the runtime version, whether files can be written, which shell it will use.',
    paths: [/(^|\/)(doctor|diagnose)\.js$/, /(^|\/)(commands|repl)\.js$/],
    content: [/'\/doctor'|"\/doctor"/],
  },
  {
    id: 'shell', name: 'Shell execution', group: 'Operability',
    plain: 'Runs real commands on your machine.',
    paths: [/(^|\/)(shell|tools)\.js$/],
    content: [/spawn\(/],
  },
  {
    id: 'terminal-title', name: 'Terminal title', group: 'Operability',
    plain: 'Puts the project name in the window title so you can find the right tab.',
    paths: [/(^|\/)termtitle\.js$/],
  },
  {
    id: 'paste', name: 'Paste handling', group: 'Interface',
    plain: 'Treats a pasted block as one piece of content, never as a series of commands.',
    paths: [/(^|\/)(input|linereader)\.js$/],
    content: [/200~|bracketed|paste/i],
  },
  {
    id: 'completion-menu', name: 'Command and file completion', group: 'Interface',
    plain: 'The slash menu and @ file picker.',
    paths: [/(^|\/)(input|linereader|panel|project)\.js$/],
    content: [/completer|completion|completePath/i],
  },
  {
    id: 'ask-user', name: 'The model can ask you', group: 'Interface',
    plain: 'The model can stop and ask a question, with the choices rendered for you to pick.',
    paths: [/tools\/ask\.js$/, /(^|\/)tools\.js$/],
    content: [/ask_user/],
  },
  {
    id: 'live-status', name: 'Liveness display', group: 'Interface',
    plain: 'Shows whether it is thinking, running something, retrying or stuck — so it never just looks frozen.',
    paths: [/(^|\/)(views|footer|screen|viewport|liveness)\.js$/],
  },
];

module.exports = { CAPABILITIES };
