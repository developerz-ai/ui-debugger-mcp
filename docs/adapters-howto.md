# How to add a new adapter

The agent loop is **adapter-blind** — it calls `open/find/click/type/pressKey/scroll/readState/
screenshot/waitFor/console/network/close` via the `Adapter` interface and never learns
which protocol is underneath. Adding a new adapter is a contained change:
config schema → adapter class → factory → (optional) session-builder hook.
Zero changes to the agent loop, belt, MCP tools, or session.

See [`docs/idea/adapters.md`](idea/adapters.md) for the conceptual model and the
managed/attach lifecycle. See [`docs/idea/desktop-control.md`](idea/desktop-control.md)
for Linux tooling (X11/Wayland input, AT-SPI2, scrot/grim, ADB).

---

## 1 — The shared contract

**`src/adapters/contract.ts`** — read this first. Every adapter implements `Adapter`.

```
open(target)           navigate / launch / start activity
find(opts)             resolve first matching node (null if none)
click(target)          click an element
type(target, text)     focus + type
pressKey(key)          dispatch a key or chord (e.g. 'Control+a')
scroll(opts)           scroll viewport or a scoped region
readState(opts?)       read the normalized UI tree (capped list of Node[])
screenshot()           capture PNG bytes
waitFor(opts)          block until a condition holds or time out
console(opts?)         drain captured log messages (newest first)
network(opts?)         drain captured network exchanges (newest first)
close()                release the target (managed: stop; attach: disconnect only)
```

All read parameters are `Query` (SQL-like `query/fields/filters/limit/within`).
Filters are whitelisted per adapter — reject unknown keys with `AdapterError`, never
silently ignore them.

**Fail loud.** Every backend error must throw `AdapterError` (or a more specific custom
class from `src/errors.ts`). Never swallow, never return a silent fallback. Re-throw
your own `UiDebuggerError` subclasses untouched; wrap foreign errors as `AdapterError`.

---

## 2 — Directory layout

Follow the existing pattern:

```
src/adapters/<name>/
  <name>-adapter.ts           # the Adapter class + public init interface
  <backend>.ts                # low-level backend(s) (seam for tests)
  <name>-adapter.test.ts      # unit tests (fake backends via constructor injection)
  <name>-adapter.integration.test.ts  # real-device tests (skip-guarded)
  … (split per SRP, ≤ 500 LOC each)
```

**Reference implementations:**

| Adapter | Reads state via | Actions via |
|---------|-----------------|-------------|
| `browser/` | Playwright + DOM extraction | CDP `Input.*` events |
| `desktop/` | AT-SPI2 over busctl (D-Bus) | xdotool (X11/XWayland) |
| `android/` | `uiautomator dump` (view hierarchy) | `adb shell input` |

---

## 3 — Write the adapter class

Three patterns to copy from:

### Constructor injection (seams for tests)

Keep backends behind thin interfaces, injected via a `create()` static factory and
overridable in tests:

```ts
export interface MyAdapterInit {
  config: MyTarget;
  backend?: MyBackend;   // override in tests
}

export class MyAdapter implements Adapter {
  readonly #backend: MyBackend;

  private constructor(backend: MyBackend, config: MyTarget) { … }

  static create(init: MyAdapterInit): MyAdapter {
    return new MyAdapter(
      init.backend ?? new RealBackend(init.config),
      init.config,
    );
  }
  …
}
```

### Error wrapping

Wrap every backend call in the same `#run` helper pattern used by `DesktopAdapter`
and `AndroidAdapter`:

```ts
async #run<T>(op: string, fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (error) {
    if (error instanceof UiDebuggerError) throw error;   // pass through our own
    throw new AdapterError(
      `<name>.${op} failed: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}
```

### Unsupported channels

If the target has no console or network channel, throw loud — never return `[]`:

```ts
async console(): Promise<ConsoleEntry[]> {
  throw new AdapterError('<target> has no console channel (unsupported)');
}
```

### Managed vs attach

If the adapter supports both modes (like browser/android), gate on a config flag:

- **attach** (`cdpUrl` / `adbSerial` set) → `close()` disconnects only; never
  starts/stops the target.
- **managed** (default) → adapter owns the lifecycle: launch in `open`, stop in
  `close`.

---

## 4 — Config schema

Add your target shape in **`src/config/schema.ts`**:

```ts
const MyTargetSchema = z.strictObject({
  adapter: z.literal('myname'),
  // … target-specific fields …
});
```

Then union it into `TargetSchema`:

```ts
export const TargetSchema = z.discriminatedUnion('adapter', [
  WebTargetSchema,
  DesktopTargetSchema,
  AndroidTargetSchema,
  MyTargetSchema,          // add here
]);
```

Export the inferred type: `export type MyTarget = z.infer<typeof MyTargetSchema>;`

---

## 5 — Factory

Wire the new case in **`src/adapters/factory.ts`**:

```ts
case 'myname':
  return MyAdapter.create({ config: target });
```

The `default` branch is typed as `never`, so TypeScript forces you to handle every
discriminant.

---

## 6 — Session-builder hook (if needed)

**`src/session/session-builder.ts`** wires the adapter into the agent loop. For most
adapters nothing changes here — the factory already returns an `Adapter` and the loop
is adapter-blind. But if your adapter needs a target-specific `open()` argument
(e.g. the web adapter receives the configured `url`, the android adapter receives the
configured package/activity), check how the builder calls `adapter.open(...)` and
extend that logic if needed.

---

## 7 — Tests

**Unit test** — fake the backend interfaces via the init seam; no real device needed:

```ts
// src/adapters/myname/myname-adapter.test.ts
import { expect, test } from 'bun:test';
import { MyAdapter } from './myname-adapter.js';

test('click resolves selector → calls backend', async () => {
  const calls: string[] = [];
  const fakeBackend = { tap: (x: number, y: number) => { calls.push(`${x},${y}`); } };
  const adapter = MyAdapter.create({ config: { adapter: 'myname', … }, backend: fakeBackend });
  await adapter.find(…);
  await adapter.click(…);
  expect(calls).toEqual([…]);
});
```

**Integration test** — skip-guarded for CI; requires real hardware or emulator:

```ts
// src/adapters/myname/myname-adapter.integration.test.ts
import { test } from 'bun:test';

const SKIP = Boolean(process.env['SKIP_MY_TESTS']);

test.skipIf(SKIP)('open + readState + close (real device)', async () => { … });
```

---

## 8 — Addendum doc (optional but recommended)

For non-trivial backends, add a `docs/idea/<name>-adapter.md` documenting:

- Protocol / toolchain (e.g. `busctl` D-Bus walk for AT-SPI2)
- Managed vs attach decision
- Known limitations and vision fallback trigger
- External dependencies / system packages needed

Reference it from `docs/idea/adapters.md`.

---

## Checklist

- [ ] `src/adapters/<name>/` — adapter class + backend seam(s)
- [ ] `src/config/schema.ts` — `MyTargetSchema` + unioned into `TargetSchema`
- [ ] `src/adapters/factory.ts` — new `case 'myname':` branch
- [ ] Unit tests (fake backends, no device required)
- [ ] Integration tests (skip-guarded; `SKIP_MY_TESTS=1` in CI)
- [ ] `bun run lint && bun run typecheck && bun test && bun run build` — all green
