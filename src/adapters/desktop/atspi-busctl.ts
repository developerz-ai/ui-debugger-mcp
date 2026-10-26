/**
 * busctl-backed AT-SPI2 reader — the integration-validated half of the desktop read.
 *
 * Moved verbatim out of `atspi.ts`: {@link BusctlAtspi} walks the a11y tree over
 * D-Bus via `busctl` (one spawn per call, bounded by `maxNodes`/`maxDepth` and an
 * optional deadline), resolving the named application/window scope FIRST so a
 * duplicate label in another app is never read. Every reply is validated by the
 * pure parsers in `atspi-parse.ts`; failures throw loud.
 */

import { AdapterError, ExecTimeoutError } from '../../errors.js';
import type { Bounds } from '../contract.js';
import {
  type AtspiNode,
  type AtspiReadOptions,
  type AtspiRef,
  type AtspiScope,
  type AtspiSource,
  describeScope,
  matchesScope,
  oneWindow,
  type ScopedWindow,
} from './atspi.js';
import {
  asString,
  busctlData,
  firstReturn,
  mapRole,
  matchesQuery,
  parseChildren,
  parseExtents,
  parseStateWords,
  stateFlags,
} from './atspi-parse.js';
import { desktopEnv, type Exec, type ExecOptions, makeExec } from './proc.js';

const A11Y_IFACE = 'org.a11y.atspi.Accessible';
const COMPONENT_IFACE = 'org.a11y.atspi.Component';
const REGISTRY_DEST = 'org.a11y.atspi.Registry';
const ROOT_PATH = '/org/a11y/atspi/accessible/root';

/** `ATSPI_COORD_TYPE_SCREEN` — extents relative to the screen, for clicks + vision. */
const COORD_SCREEN = 0;

/** Placeholder bounds for a node with no `Component` — paired with `measured: false`. */
const UNMEASURED_BOUNDS: Bounds = { x: 0, y: 0, width: 0, height: 0 };

/** Walk caps — keep the (spawn-heavy) tree read bounded. */
const DEFAULT_MAX_NODES = 200;
const DEFAULT_MAX_DEPTH = 25;

/** A busctl invocation (args only — the `busctl` binary is fixed). Injected for tests. */
export type BusctlExec = (args: string[], opts?: ExecOptions) => Promise<string>;

/**
 * {@link AtspiSource} backed by `busctl`. Walks the a11y tree breadth-first from the
 * registry root, bounded by `maxNodes`/`maxDepth`. Resolves the a11y bus address once
 * and caches it. Every reply is validated by the pure parsers above; failures throw loud.
 */
export class BusctlAtspi implements AtspiSource {
  readonly #exec: BusctlExec;
  #address: string | null = null;

  constructor(init: { display?: string; exec?: BusctlExec } = {}) {
    const exec: Exec = makeExec(desktopEnv(init.display));
    this.#exec = init.exec ?? ((args, opts) => exec('busctl', args, opts));
  }

  async readTree(opts: AtspiReadOptions = {}): Promise<AtspiNode[]> {
    const maxNodes = opts.maxNodes ?? DEFAULT_MAX_NODES;
    const maxDepth = opts.maxDepth ?? DEFAULT_MAX_DEPTH;
    const query = opts.query;
    const deadline = opts.deadline;
    const out: AtspiNode[] = [];
    const seen = new Set<string>();
    // Start at the registry root's children (apps); the desktop root itself is not UI.
    // A scoped read resolves the application/window it is bound to FIRST: the
    // registry spans EVERY application on the desktop, so an unscoped walk
    // resolves a label like "Save" against whichever app answered first and
    // the click lands in the wrong window.
    let frontier: AtspiRef[];
    if (opts.scope) {
      // The scoped walk resolves its own root and reports why it could not:
      // an exhausted deadline and a scope that matches nothing are different
      // failures, and the caller must not read one as the other.
      frontier = await this.#scopeRoots(opts.scope, deadline, maxDepth);
    } else {
      // Already out of time: spend no spawn at all — there is nothing left to read.
      if (deadline !== undefined && Date.now() >= deadline) return out;
      frontier = await this.#children({ dest: REGISTRY_DEST, path: ROOT_PATH }, deadline);
    }
    for (let depth = 0; frontier.length > 0 && depth < maxDepth; depth += 1) {
      const next: AtspiRef[] = [];
      for (const ref of frontier) {
        // With a query, `out` holds only matches — so this also stops the walk as
        // soon as enough matches are found, not merely enough nodes visited.
        if (out.length >= maxNodes) return out;
        // Out of time: stop before spending another pair of spawns on this node.
        if (deadline !== undefined && Date.now() >= deadline) return out;
        const key = `${ref.dest}${ref.path}`;
        if (seen.has(key)) continue;
        seen.add(key);
        const { role, name } = await this.#roleAndName(ref, deadline);
        // A query-pruned non-match: skip the State/Extents calls (they'd just be
        // filtered out downstream) but keep walking its children for deeper matches.
        if (
          !query ||
          matchesQuery({ role, name, bounds: UNMEASURED_BOUNDS, enabled: false }, query)
        ) {
          out.push(await this.#describeRest(ref, role, name, deadline));
        }
        next.push(...(await this.#children(ref, deadline)));
      }
      frontier = next;
    }
    return out;
  }

  /**
   * Resolve the scope to the ONE tree root the walk starts from.
   *
   * The registry root's children ARE the applications on the desktop, so the
   * scope is resolved against them first — an unscoped walk starts there and
   * therefore sees EVERY application, which is how a duplicate label ("Save"
   * in two apps) resolves to the wrong one.
   *
   * The scope resolves to exactly ONE root, never a set: the walk starts from
   * every root it is handed, so two of them put two applications' subtrees in
   * the result and the lookup resolves against whichever the bus listed
   * first — the duplicate-label hole this scope exists to close. A scope that
   * names two applications, or two windows, is ambiguous: it fails loud
   * instead of guessing which one was meant.
   *
   * Resolution order: a `class` names the application outright — the title
   * then only picks the window inside it, and other applications whose NAMES
   * carry the title are irrelevant. Without a class, matching WINDOWS come
   * first: a window actually titled "Doc" beats an application merely named
   * "Doc Editor"; only when no window carries the title is an application
   * carrying it taken as the scope.
   *
   * The top level is matched as an application whatever role the toolkit
   * reports for it (real trees say `application`, some say `frame`), so the
   * match must not depend on that role string.
   *
   * A scope that matches nothing resolves to no root at all: the caller then
   * fails loud instead of reading a tree that belongs to another application.
   */
  async #scopeRoots(
    scope: AtspiScope,
    deadline: number | undefined,
    maxDepth: number,
  ): Promise<AtspiRef[]> {
    // Out of time before the search even starts: no root can be resolved, and
    // the caller must not read that as "the scope matched nothing".
    if (deadline !== undefined && Date.now() >= deadline) {
      throw new AdapterError(
        'AT-SPI: the scoped walk ran out of time before it reached the scoped window',
      );
    }
    const apps = await this.#children({ dest: REGISTRY_DEST, path: ROOT_PATH }, deadline);
    // Which applications does the scope name? The class is the application's
    // OWN identity, so it decides the application; the title names the WINDOW
    // inside it. An application matched by class is the one the scope is
    // bound to — the title then picks the window within it.
    const byTitle: AtspiRef[] = [];
    const byClass: AtspiRef[] = [];
    for (const ref of apps) {
      const { name } = await this.#roleAndName(ref, deadline);
      if (matchesScope({ role: 'application', name }, { class: scope.class })) {
        byClass.push(ref);
      } else if (matchesScope({ role: 'application', name }, { title: scope.title })) {
        byTitle.push(ref);
      }
    }
    // The class is the application's OWN identity: once it names an
    // application, the scope is bound to THAT application and the title only
    // picks the window inside it. Other applications whose NAMES carry the
    // title are irrelevant — they must not trip an application-title
    // ambiguity, and the read must never be handed to them.
    if (byClass.length > 0) {
      const window = oneWindow(await this.#windowsUnder(byClass, scope, deadline, maxDepth), scope);
      if (window) return [window.ref];
      if (byClass.length > 1) {
        throw new AdapterError(
          `AT-SPI: the scope (${describeScope(scope)}) is ambiguous — ${byClass.length} applications ` +
            'carry that class; the scope must name exactly one',
        );
      }
      // The class matched exactly one application but the title matched no
      // window in it. Returning the whole application would let find/click
      // resolve labels in ANOTHER window of that app — the one thing a scoped
      // read must never do. Fail loud instead.
      if (scope.title) {
        throw new AdapterError(
          `AT-SPI: the scope (${describeScope(scope)}) matched the application but no window in it ` +
            'carries that title; the scope must name a window that exists',
        );
      }
      return byClass; // exactly one application, and no title to narrow it by
    }
    // No class: matching WINDOWS come first. An application whose NAME merely
    // carries the title must not win while the window actually titled so
    // lives in another application — that hands find/click to the wrong app.
    // Only when NO window carries the title is an application named by it
    // taken as the scope, and two of those is an ambiguity, not a choice.
    if (scope.title) {
      const window = oneWindow(await this.#windowsUnder(apps, scope, deadline, maxDepth), scope);
      if (window) return [window.ref];
      if (byTitle.length > 1) {
        throw new AdapterError(
          `AT-SPI: the scope (${describeScope(scope)}) is ambiguous — ${byTitle.length} applications ` +
            'carry that title; the scope must name exactly one',
        );
      }
      if (byTitle.length === 1) return byTitle;
    }
    // Nothing matched. A deadline that expired on the way here is a timeout,
    // not a miss: reporting it as "no match" would send the caller looking for
    // a window that is simply out of reach in the time it had.
    if (deadline !== undefined && Date.now() >= deadline) {
      throw new AdapterError(
        'AT-SPI: the scoped walk ran out of time before it reached the scoped window',
      );
    }
    throw new AdapterError(
      `AT-SPI: no application or window matched the scope (${describeScope(scope)})`,
    );
  }

  /**
   * The windows inside these applications whose name carries the scoped title.
   *
   * A walk that gave up mid-search (deadline spent) is a failure, not a
   * partial answer: acting on the hits found so far would read a window the
   * scope never actually named.
   */
  async #windowsUnder(
    apps: AtspiRef[],
    scope: AtspiScope,
    deadline: number | undefined,
    maxDepth: number,
  ): Promise<ScopedWindow[]> {
    const windows: ScopedWindow[] = [];
    for (const app of apps) {
      windows.push(...(await this.#windowsIn(app, scope, deadline, maxDepth)));
      if (deadline !== undefined && Date.now() >= deadline) {
        throw new AdapterError(
          'AT-SPI: the scoped walk ran out of time before it reached the scoped window',
        );
      }
    }
    return windows;
  }

  /**
   * The windows inside `app` whose name carries the scoped title.
   *
   * Only container roles are descended into: a window's children are its
   * widgets, and a widget's subtree never holds another toplevel. That keeps
   * the scoped search from walking an entire application just to find its
   * frame.
   */
  async #windowsIn(
    app: AtspiRef,
    scope: AtspiScope,
    deadline: number | undefined,
    maxDepth: number,
  ): Promise<ScopedWindow[]> {
    const title = scope.title?.toLowerCase() ?? '';
    if (title === '') return [];
    const hits: ScopedWindow[] = [];
    const seen = new Set<string>();
    let frontier = await this.#children(app, deadline);
    for (let depth = 0; frontier.length > 0 && depth < maxDepth; depth += 1) {
      const next: AtspiRef[] = [];
      for (const ref of frontier) {
        if (deadline !== undefined && Date.now() >= deadline) return hits;
        const key = `${ref.dest}${ref.path}`;
        if (seen.has(key)) continue;
        seen.add(key);
        const { role, name } = await this.#roleAndName(ref, deadline);
        if (role === 'window') {
          if (name.toLowerCase().includes(title)) hits.push({ ref, name });
          continue; // a window's children are its widgets, never another toplevel
        }
        if (role !== 'application' && role !== 'dialog') continue;
        next.push(...(await this.#children(ref, deadline)));
      }
      frontier = next;
    }
    return hits;
  }

  /**
   * One busctl spawn, bounded by the walk's deadline.
   *
   * The subprocess is capped by the time left until the deadline, so a wedged bus
   * cannot hold the walk (and the `waitFor` that asked for it) past its timeout. A
   * reply that arrives after the deadline is a failure, not a partial tree: the
   * caller must not read a stale tree as the answer.
   */
  async #spawn(args: string[], deadline: number | undefined): Promise<string> {
    const out = await this.#exec(args, deadline === undefined ? undefined : { deadline });
    if (deadline !== undefined && Date.now() >= deadline) {
      throw new ExecTimeoutError(
        `desktop: \`busctl\` resolved after the walk deadline (${deadline}) had passed`,
      );
    }
    return out;
  }

  /** Resolve (and cache) the a11y peer-bus address via the session bus. */
  async #a11yAddress(deadline?: number): Promise<string> {
    if (this.#address) return this.#address;
    const data = busctlData(
      await this.#spawn(
        [
          '--user',
          '--json=short',
          'call',
          'org.a11y.Bus',
          '/org/a11y/bus',
          'org.a11y.Bus',
          'GetAddress',
        ],
        deadline,
      ),
    );
    const address = asString(firstReturn(data, 'GetAddress'), 'a11y bus address');
    if (address === '') throw new AdapterError('AT-SPI: empty a11y bus address');
    this.#address = address;
    return address;
  }

  /** Call a method on the a11y bus, returning the parsed `data` array of return values. */
  async #call(
    ref: AtspiRef,
    iface: string,
    member: string,
    extra: string[] = [],
    deadline?: number,
  ): Promise<unknown> {
    const address = await this.#a11yAddress(deadline);
    return busctlData(
      await this.#spawn(
        [
          `--address=${address}`,
          '--json=short',
          'call',
          ref.dest,
          ref.path,
          iface,
          member,
          ...extra,
        ],
        deadline,
      ),
    );
  }

  async #children(ref: AtspiRef, deadline?: number): Promise<AtspiRef[]> {
    return parseChildren(
      firstReturn(await this.#call(ref, A11Y_IFACE, 'GetChildren', [], deadline), 'GetChildren'),
    );
  }

  /** Read the `Name` property as a plain scalar (`get-property` avoids a variant wrapper). */
  async #name(ref: AtspiRef, deadline?: number): Promise<string> {
    const address = await this.#a11yAddress(deadline);
    const data = busctlData(
      await this.#spawn(
        [
          `--address=${address}`,
          '--json=short',
          'get-property',
          ref.dest,
          ref.path,
          A11Y_IFACE,
          'Name',
        ],
        deadline,
      ),
    );
    return asString(data, 'Name');
  }

  /** Read just role + name — cheap enough to spend on every node for query pruning. */
  async #roleAndName(ref: AtspiRef, deadline?: number): Promise<{ role: string; name: string }> {
    const roleName = asString(
      firstReturn(await this.#call(ref, A11Y_IFACE, 'GetRoleName', [], deadline), 'GetRoleName'),
      'GetRoleName',
    );
    return { role: mapRole(roleName), name: await this.#name(ref, deadline) };
  }

  /** Finish describing a node (state + extents) once its role/name are known to matter. */
  async #describeRest(
    ref: AtspiRef,
    role: string,
    name: string,
    deadline?: number,
  ): Promise<AtspiNode> {
    const { enabled, visible } = stateFlags(
      parseStateWords(
        firstReturn(await this.#call(ref, A11Y_IFACE, 'GetState', [], deadline), 'GetState'),
      ),
    );
    // Application roots + some toolkit filler nodes don't implement Component, so
    // busctl exits non-zero on GetExtents. Keep the node (killing the whole walk over
    // an unmeasurable filler helps nobody) but mark it `measured: false` — the zeros
    // below are a placeholder, never geometry. Role/name/state failures stay loud.
    // An expired per-call cap (`proc.ts`) is not "no Component":
    // swallowing it would spend the cap again on every remaining node of the walk.
    const extents = await this.#call(
      ref,
      COMPONENT_IFACE,
      'GetExtents',
      ['u', String(COORD_SCREEN)],
      deadline,
    ).catch((error: unknown) => {
      if (error instanceof ExecTimeoutError) throw error;
      return null;
    });
    const bounds =
      extents === null ? UNMEASURED_BOUNDS : parseExtents(firstReturn(extents, 'GetExtents'));
    return { role, name, bounds, enabled, visible, measured: extents !== null };
  }
}
