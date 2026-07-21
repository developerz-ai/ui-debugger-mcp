# ui-debbugger-mcp

An MCP server that debugs UIs autonomously, so a human never has to click through a broken interface. A smart calling agent (Claude) hands it a goal — a "story" — and a small, fast agent running *inside* this server drives the browser, desktop app, or Android emulator, gathers evidence, and reports findings. The caller fixes the code and asks again; the loop repeats until the UI works. Three actors cooperate: the **smart agent** (the boss, sets goals and fixes code), the **fast guy** (a fast text-only driver that controls the target), and the **vision guy** (multimodal, describes screenshots and judges whether things look right). Stated goal: stuff works *and* looks nice.

- **Stack:** Bun + TypeScript, Vercel AI SDK for the in-server agent loop, any OpenAI-compatible router (OpenRouter by default; deepseek for text, glm for images). Zod for validation, Biome for lint/format, `bun test`. Ships as an npm package run via `npx`/`bunx`; transport is MCP over stdio. Targets are driven by CDP (web), X11/Wayland input (desktop), and ADB/uiautomator (Android).
- **Key commands:**
  - `bun run dev` — `bun --watch src/main.ts`
  - `bun run start` — run the server
  - `bun run build` — `tsc -p tsconfig.build.json`
  - `bun run typecheck` · `bun test` · `bun run lint` / `lint:fix` · `bun run format`
- **Layout:**
  - `src/main.ts` — boot the stdio MCP server
  - `src/mcp/` — MCP server and tool definitions; deliberately few fat tools, not one-per-action
  - `src/agent/` — the Vercel AI SDK debug loop (fast guy + vision guy), with in-repo versioned system `prompts/`
  - `src/adapters/` — target control behind one shared contract: `browser/` (CDP), `desktop/` (X11/Wayland), `android/` (ADB) — all three shipped, each runnable managed or attach
  - `src/session/`, `src/config/`, `src/services/` — cwd-keyed sessions and per-project workspace, `.ui-debugger-mcp.json` loading, business logic
  - `docs/`, `dummy/`, `dist/` — design docs (`docs/idea/models.md`), a test target, build output
- **Constraints:** sessions are keyed by current directory (one project = one session), and only one debug run at a time since the persistent Chrome profile locks. iOS is out of scope on Linux.
- **State as of 2026-07-21:** on branch `fix/findings-pipeline`; working tree was clean when this note was written.
