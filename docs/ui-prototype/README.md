# UI prototype — validated, not yet integrated

These three modules are the working prototype from the workspace-redesign pass.
They are **deliberately outside `src/`**: the redesign brief asked for a
prototype to be built and evaluated before the real TUI was restructured, and
`tests/unit/architecture.test.js` requires every file under `src/` to be
reachable from `cli.js`. A module sitting in `src/` that nothing dispatches is
dead code by that guard's definition, and rightly so.

They are kept because the work is finished and measured, not speculative.

| file | what it is | state |
|---|---|---|
| `doc.js` | a structured document model — titles, sections, aligned key/value fields, bullets, notes — and a renderer that wraps ANSI-aware and **losslessly** | prototype validated at 100/64/42 columns |
| `workspace.js` | the five views: PROJECT · CONTEXT · WORK · CHANGES · VERIFY, each building a `doc()` | renders, not yet dispatched |
| `concerns.js` | persistent per-project concerns, stored in LAIN's config home, surviving compaction and restart | complete, no command wired |

## What the prototype established

Rendering structure rather than prose works, and it survives narrow terminals:

```
OPERATIONAL CONTRACT
  Shell         powershell
    NOT && — Windows PowerShell 5.1 has no such operator; it arrived in
    PowerShell 7
  CWD           C:\Users\Hartezmenot\Documents\lain-v2
  Lines         1-based
  Byte offsets  0-based
  Range end     exclusive
```

One defect was found and fixed while prototyping: `wrap()` broke long unbreakable
tokens with `T.clip`, which **appends an ellipsis and returns a string longer
than the text it represents**, so advancing by its length skipped characters.
`C:\Users\…\src\ui` came back as `C:\Users\Hartezmeno…\Documents\lain-v2\…rc\ui`
— an ellipsis in the middle and a missing `s`. A path a reader cannot copy is a
path that is not there. It now uses a display-width slice that prefers breaking
at a path separator, and joining the pieces reproduces the input exactly.

## What integration still needs

- `ui/tabs.js` — replace the seven-view list with the five
- `ui/layout.js:workspaceLines()` — dispatch to these builders
- a `/concern` command, so `concerns.js` becomes reachable
- the existing tests that assume `context` is the transcript will need updating,
  because under the redesign `context` becomes the knowledge view and the
  transcript moves to `work`

That last item is the real cost of the change and is why it was not done
half-way.
