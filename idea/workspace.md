# Per-project workspace

Each project gets its own space — the debug agent's memory and evidence locker
for that app. Keyed by the current dir.

```
./tmp/ui-debugger-mcp/<project>/
├── chrome-user-data/          persistent browser profile
│                              (login, cookies, localStorage, prefs)
├── sessions/<id>/
│   ├── story.md               the goal the smart agent gave
│   ├── screenshots/           before / after / on-failure (+ per target)
│   ├── findings.json          structured report back to the smart agent
│   └── logs/
│       ├── console.log        browser / app console
│       ├── network.log        requests, responses, failures, timings
│       ├── agent.log          small agent's step-by-step trail
│       └── cdp.log            raw protocol (deep debugging only)
└── state.json                 session state, keyed by cwd
```

## Why each piece

| Path                | Why |
|---------------------|-----|
| `chrome-user-data/` | Login survives runs. No re-auth each time. Works with `?debug-ai`. |
| `story.md`          | What was asked. Becomes the integration-test spec later. |
| `screenshots/`      | Evidence for visual feedback; lets the smart agent judge too. |
| `findings.json`     | The structured verdict. Smart agent reads this, not prose. |
| `console.log`       | JS errors a code-only agent can't see. |
| `network.log`       | The 500s / hangs / bad payloads behind a broken UI. |
| `agent.log`         | Why the small agent decided pass/fail. Auditable. |
| `cdp.log`           | Last-resort protocol-level debugging. |
| `state.json`        | Resume / inspect the cwd-keyed session. |

## Rules

- **One session at a time** per project — the persistent profile locks itself.
  Parallel runs would need a cloned profile; out of scope for now.
- Lives under `./tmp/` so it never pollutes the repo (gitignore `tmp/`).
- Findings reference evidence by path, so the smart agent can open a screenshot
  or grep a log without the server inlining huge blobs into context.

## Lifecycle

- New story → new `sessions/<id>/`.
- Profile (`chrome-user-data/`) persists across sessions.
- Old sessions can be pruned; the profile stays.
