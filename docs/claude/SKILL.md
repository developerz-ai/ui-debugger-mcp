---
name: using-claude-cli
description: How to drive `claude` (Claude Code) as a non-interactive CLI tool — headless runs, MCP servers, permissions, output formats, and piping. Use when scripting Claude, spawning a sub-agent from another process, or wiring Claude into CI/automation.
---

# Using `claude` as a tool

`claude` (Claude Code) is interactive by default, but it's also a scriptable CLI:
give it a prompt, let it run autonomously, capture the result. This is how you
spawn a Claude "sub-agent" from a script, a hook, or another Claude.

## One-shot (headless) runs

```bash
claude -p "Summarize the failing tests in this repo"        # print result, exit
```

- `-p, --print` — run once, print the final message, exit (no REPL).
- `--output-format text|json|stream-json` — `text` (default) for humans;
  `json` for a single structured result; `stream-json` to read events live
  (pair with `--verbose`).
- `--model <id>` — pick the model for this run (e.g. a fast model for cheap jobs).
- Prompt can come from an arg, a file, or stdin:
  ```bash
  claude -p "$(cat task.txt)"
  echo "explain this error" | claude -p
  ```

## Permissions (the usual headless gotcha)

Headless runs can't show permission prompts, so a tool that needs approval just
stalls. Choose one:

- `--permission-mode acceptEdits` — auto-accept file edits, still gate the rest.
- `--allowedTools "Bash(git*) mcp__myserver__*"` — allowlist exactly what may run.
- `--dangerously-skip-permissions` — bypass ALL checks. Only in a sandbox / on a
  throwaway target you trust. Never against production or with secrets in reach.

## MCP servers

```bash
claude -p "Use the debugger to QA the app" \
  --mcp-config ./.mcp.json --strict-mcp-config \
  --allowedTools "mcp__ui-debugger__*"
```

- `--mcp-config <file...>` — load MCP servers from explicit JSON files.
- `--strict-mcp-config` — use ONLY those, ignoring auto-discovered project configs
  (reproducible, no surprise servers).
- MCP tools are named `mcp__<server>__<tool>` — match that in `--allowedTools`.
- The MCP server inherits the spawned process's env + cwd; put per-run secrets in
  the `.mcp.json` `env` block (and keep that file out of git).

## Sessions

- `--continue` — resume the most recent session in this directory.
- `--resume <session-id>` — resume a specific one.
- Each working directory is its own session context.

## Patterns

- **Sub-agent from a script**: `claude -p "<task>" --output-format json` then parse
  the result. Give a tight, self-contained prompt and tell it not to ask questions
  (a headless run can't answer back).
- **CI gate**: `claude -p "review the diff; exit non-zero notes if risky"` with a
  narrow `--allowedTools`.
- **Long autonomous job**: stream it — `--output-format stream-json --verbose` — and
  watch for the terminal event so silence (a hang) is distinguishable from success.

## Cautions

- A headless agent can't pause for input — make the prompt fully specify the goal
  and the stop condition.
- Skipping permissions + a powerful toolset is a real blast radius. Scope tools,
  prefer an isolated worktree or throwaway target, never point it at prod.
- Pin `--model` and `--strict-mcp-config` for runs you need to be reproducible.
