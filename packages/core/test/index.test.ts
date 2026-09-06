import { describe, expect, test } from "bun:test";
import * as core from "../src/index";
import type { ActorId, BoardKind, BoardRef, TicketId } from "../src/types";
import type { Equal, Expect, IsAssignable } from "./typeLevel";

/*
 * The import above is relative rather than `@jeff-roche/cankan-core` because
 * `packages/core` has no symlink to itself — a package is not its own
 * dependency. Consumers such as `packages/cli` resolve the package specifier
 * normally. `../src/index` is the exact module `package.json`'s `main` and
 * `types` point at, so this exercises the same export map a consumer of the
 * package name resolves to.
 */

/**
 * The core module folders, each read off the public
 * entry statically — a dynamic `core[folder]` lookup is a biome warning, and
 * warnings fail the lint gate.
 */
const MODULE_NAMESPACES = {
  ticket: core.ticket,
  config: core.config,
  board: core.board,
  store: core.store,
  git: core.git,
  events: core.events,
  state: core.state,
  claims: core.claims,
  deps: core.deps,
  order: core.order,
  index: core.index,
  hooks: core.hooks,
  actor: core.actor,
  trust: core.trust,
};

type ModuleFolder = keyof typeof MODULE_NAMESPACES;

/**
 * The flat (non-namespaced) value exports, from `errors.ts`.
 *
 * MAINTENANCE: a later lane appending a *value* export to `errors.ts` or
 * `types.ts` must add its name in two places — here, and the `expected` list
 * in "exposes nothing beyond the thirteen namespaces and the flat errors
 * surface" below. Type-only exports need neither. Both failures are loud.
 */
type FlatValueExport = "CanKanError" | "ErrorCodes" | "isCanKanError";

/** Every namespace on the public entry, i.e. its keys minus the flat ones. */
type EntryNamespace = Exclude<keyof typeof core, FlatValueExport>;

export type EntryTypeAssertions = [
  // The entry exposes exactly the declared folders as namespaces: no folder
  // missing, and no extra namespace beyond the list.
  Expect<Equal<EntryNamespace, ModuleFolder>>,
  // `errors.ts` and `types.ts` are re-exported flat, so their types are
  // reachable directly off the entry rather than through a namespace.
  Expect<Equal<core.BoardRef, BoardRef>>,
  Expect<Equal<core.BoardKind, BoardKind>>,
  Expect<Equal<core.TicketId, TicketId>>,
  Expect<Equal<core.ActorId, ActorId>>,
  // `BoardRef` carries exactly five fields, with the right types. Both board
  // kinds populate all five, so it stays a flat interface, not a union.
  Expect<
    Equal<
      keyof BoardRef,
      "kind" | "name" | "root" | "ticketsDir" | "coordinationRef"
    >
  >,
  Expect<Equal<BoardRef["kind"], BoardKind>>,
  Expect<Equal<BoardKind, "repo" | "personal">>,
  Expect<Equal<BoardRef["name"], string>>,
  Expect<Equal<BoardRef["root"], string>>,
  Expect<Equal<BoardRef["ticketsDir"], string>>,
  Expect<Equal<BoardRef["coordinationRef"], string>>,
  // The ID brands: a plain string is not an ID, an ID is a string, and the
  // two brands do not cross.
  Expect<Equal<IsAssignable<string, TicketId>, false>>,
  Expect<Equal<IsAssignable<TicketId, string>, true>>,
  Expect<Equal<IsAssignable<string, ActorId>, false>>,
  Expect<Equal<IsAssignable<ActorId, string>, true>>,
  Expect<Equal<IsAssignable<TicketId, ActorId>, false>>,
  Expect<Equal<IsAssignable<ActorId, TicketId>, false>>,
];

// Positive counterparts to the `@ts-expect-error` negatives below: these must
// compile, so a negative that passes for the wrong reason (a broken import,
// say, which would make every line an error) cannot hide.
const ticketId = "ck-a1b2c3" as TicketId;
const actorId = "alice" as ActorId;
export const widenedTicketId: string = ticketId;
export const widenedActorId: string = actorId;
export const repoKind: BoardKind = "repo";
export const personalKind: BoardKind = "personal";

// @ts-expect-error a plain string is not a TicketId — callers narrow with
// `as TicketId` until M2.2's `ticket/id.ts` lands
export const unbrandedTicketId: TicketId = "ck-a1b2c3";

// @ts-expect-error a TicketId is not an ActorId
export const crossedBrand: ActorId = ticketId;

// @ts-expect-error `--board all` resolves to a list of BoardRefs, so "all"
// is deliberately not a BoardKind
export const allKind: BoardKind = "all";

describe("the public entry", () => {
  test("exposes all module folders as namespaces", () => {
    const folders = Object.entries(MODULE_NAMESPACES);

    expect(folders).toHaveLength(14);
    for (const [name, namespace] of folders) {
      expect(namespace, `core.${name}`).toBeTypeOf("object");
      expect(namespace, `core.${name}`).not.toBeNull();
    }
  });

  test("resolves the `index/` folder to the folder, not to itself", () => {
    // `export * as index from "./index/index"` — had this been written
    // `"./index"`, `core.index` would be the entry namespace itself and so
    // would carry the other twelve folders (`ticket` among them, which
    // `index/` itself is forbidden from ever importing — R1, M2.14).
    // M2.14 populated `index/index.ts` with its real public surface, so
    // this no longer asserts emptiness (only ever true before M2.14
    // landed) — it asserts the real surface is there instead.
    expect(core.index).toBeTypeOf("object");
    expect(core.index).toHaveProperty("openIndex");
    expect(core.index).toHaveProperty("reindex");
    expect(core.index).toHaveProperty("queryTickets");
    expect(core.index).not.toHaveProperty("ticket");
  });

  test("re-exports errors and types flat", () => {
    expect(core.CanKanError).toBeTypeOf("function");
    expect(core.isCanKanError).toBeTypeOf("function");
    expect(core.ErrorCodes).toBeTypeOf("object");
  });

  test("exposes nothing beyond the thirteen namespaces and the flat errors surface", () => {
    const expected = [
      ...Object.keys(MODULE_NAMESPACES),
      "CanKanError",
      "ErrorCodes",
      "isCanKanError",
    ].sort();
    expect(Object.keys(core).sort()).toEqual(expected);
  });
});

describe("BoardRef", () => {
  test("describes a repo board and the personal board with the same five fields", () => {
    const repoBoard: BoardRef = {
      kind: "repo",
      name: "api",
      root: "/srv/api",
      // CONCEPT.md's default `tickets_dir` — the Backlog.md-compatible layout.
      ticketsDir: "/srv/api/backlog/tasks",
      coordinationRef: "refs/cankan/coordination",
    };
    const personalBoard: BoardRef = {
      kind: "personal",
      name: "personal",
      root: "/home/u/.local/share/cankan/personal",
      ticketsDir: "/home/u/.local/share/cankan/personal/backlog/tasks",
      coordinationRef: "refs/cankan/coordination",
    };

    expect(Object.keys(repoBoard).sort()).toEqual(
      Object.keys(personalBoard).sort(),
    );
    expect(Object.keys(repoBoard).sort()).toEqual([
      "coordinationRef",
      "kind",
      "name",
      "root",
      "ticketsDir",
    ]);
  });
});
