# UI Debugger MCP — Reference

## Outer MCP Tools

Five conversational tools exposed to the smart agent (caller). All params validated via Zod.

---

### `describe`

List this project's configured debug targets, resolved per-role models, and workspace path. Call first to discover valid `target` values for `start_debug`.

| Param | Type | Required | Description |
|-------|------|----------|-------------|
| `target` | `string` | no | Narrow output to a single target by name. |

**Returns** — catalog of targets (name, adapter, managed vs attach, wired status, URL/headless for web) plus models and workspace.

---

### `start_debug`

Open a debug session: hand the driver agent a goal for a configured target. One run per project (cwd) at a time.

| Param | Type | Required | Description |
|-------|------|----------|-------------|
| `target` | `string` | yes | Target name from `.ui-debugger-mcp.json` (e.g. `"web"`). Use `describe` to list valid values. |
| `goal` | `string` | yes | The story — what to accomplish in plain language (e.g. `"log in and add item 3 to cart"`). |
| `criteria` | `string` | no | Explicit pass/fail rules, one per line. Omit to let the agent judge. |
| `timeout` | `number` (int, seconds) | no | Wall-clock cap before the run auto-ends and frees the browser/profile. Default: 300 s. Max: 2 147 483 s. |

**Returns** — `{ session_id: string }`.

---

### `send_message`

Talk to the running driver mid-run: add work, redirect it, or answer a question. The message is folded into the agent conversation before the next step; no restart.

| Param | Type | Required | Description |
|-------|------|----------|-------------|
| `session_id` | `string` | yes | From `start_debug`. |
| `message` | `string` | yes | Instruction in plain language (e.g. `"skip checkout, focus on the login form"`). |

**Returns** — ack.

---

### `get_findings`

Poll the run: status plus the full structured findings snapshot. Supports long-polling and field projection to keep the payload small.

| Param | Type | Required | Description |
|-------|------|----------|-------------|
| `session_id` | `string` | yes | From `start_debug`. |
| `wait` | `number` (int, ms, 0–120 000) | no | Long-poll up to this many ms for a terminal verdict before reading. Omit or `0` to read immediately. |
| `fields` | `FindingsField[]` | no | Project a subset of findings keys (e.g. `["status","bugs"]`). Omit for the whole object. Valid values: `status`, `steps`, `bugs`, `visual`, `summary`, `evidence`. |

**Returns** — `Findings` object (see schema below), possibly projected.

---

### `end_session`

Stop and tear down the active run. Aborts the agent loop, releases the target (managed Chrome is stopped; attached browser is only disconnected), and frees the project lock.

| Param | Type | Required | Description |
|-------|------|----------|-------------|
| `session_id` | `string` | yes | From `start_debug`. |

**Returns** — ack. The last `get_findings` snapshot remains on disk.

---

## Findings Schema

`Findings` is the structured result of a debug run. Flushed incrementally by the driver loop; read via `get_findings`.

```
Findings {
  status   "running" | "passed" | "failed"
  steps    Step[]
  bugs     Bug[]
  visual   VisualIssue[]
  summary  string?
  evidence string?          // workspace-relative path to screenshots / logs dir
}
```

### `status`

| Value | Meaning |
|-------|---------|
| `"running"` | Agent still executing. |
| `"passed"` | All steps succeeded; no blocking bugs found. |
| `"failed"` | A step failed or a blocking bug was detected. |

### `steps` — `Step[]`

Ordered trail of actions the driver took.

| Field | Type | Description |
|-------|------|-------------|
| `step` | `string` | Human-readable action description. |
| `ok` | `boolean` | Whether the step succeeded. |
| `note` | `string?` | Extra detail (error message, observation). |
| `screenshot` | `string?` | Path to screenshot captured at this step. |

### `bugs` — `Bug[]`

Functional issues detected.

| Field | Type | Description |
|-------|------|-------------|
| `kind` | `"console" \| "network" \| "flow"` | Source: JS console error, network failure, or flow/logic bug. |
| `detail` | `string` | Description of the bug. |
| `evidence` | `string?` | Path to supporting evidence (screenshot or log excerpt). |

### `visual` — `VisualIssue[]`

Visual/UX feedback from the vision agent.

| Field | Type | Description |
|-------|------|-------------|
| `issue` | `string` | What looks wrong or could be improved. |
| `where` | `string` | UI location (component, page, region). |
| `severity` | `"low" \| "medium" \| "high"` | Impact on visual quality/usability. |
| `screenshot` | `string?` | Path to screenshot showing the issue. |

### `summary`

`string | undefined` — Plain-language verdict from the driver after the run completes.

### `evidence`

`string | undefined` — Workspace-relative path to the session's evidence directory (`sessions/<id>/`), containing screenshots and logs.

---

## Typical Flow

```
describe                          # find valid target names
start_debug target goal           # open a run → session_id
  └─ [optional] send_message      # steer mid-run
get_findings wait=30000           # long-poll for verdict
  └─ repeat if status="running"
end_session                       # release lock when done
```
