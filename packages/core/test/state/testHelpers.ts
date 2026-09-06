import { parseEvent, type EventRecord } from "../../src/events/index";
import type { CankanBlock, ParsedTicket, StoredTicket, TicketFrontmatter } from "../../src/store/index";
import type { TicketId } from "../../src/types";

/**
 * A deterministic, structurally-valid 26-character ULID for fixtures —
 * every character is a digit, and digits are valid Crockford base32
 * characters, so this always passes `events/schema.ts`'s `ULID_PATTERN`
 * without needing the real `ulid` package. Fixed-width and zero-padded, so
 * two of these compare the same way numerically and lexicographically —
 * deliberately, so a test that wants "an id that sorts opposite of chain
 * position" has to pick its `n` values for that on purpose (see
 * `fold.test.ts`'s tie-break test), rather than getting it by accident.
 * `n` up to 999,999 — wide enough for the I2 quadratic-alias-resolution
 * regression test's several-thousand-event fixture.
 */
export function fixedEventId(n: number): string {
  if (n < 0 || n > 999_999) {
    throw new Error("fixedEventId: n must be in [0, 999999]");
  }
  return `01${"0".repeat(18)}${String(n).padStart(6, "0")}`;
}

/** A raw, not-yet-validated event candidate — every field `parseEvent` needs, kind-specific fields included. */
export type FixtureEventInput = Record<string, unknown> & { readonly event: string; readonly ticket: string };

/**
 * Monotonic counter backing `fixtureEvent`'s default `id` — only used when
 * a test does not care what the id is (a filler `create`/`comment`, say).
 * Every test that cares about a specific `firstSeen`/tie-break outcome
 * passes its own `id` explicitly instead of relying on this.
 */
let defaultIdCounter = 0;

/**
 * Builds one `EventRecord` from a raw candidate, routed through the real
 * `parseEvent` (never a hand-built object cast to `Event`) so every fixture
 * is canonicalized/validated exactly the way production events are —
 * `ticket`/`alias.from`/`alias.to` lowercased, `id` branded, etc. Defaults
 * `ts`/`actor`/`id` so most call sites only need to name what the test is
 * actually about; `month`/`line` (the chain-position coordinate this
 * module's tie-break actually keys on) are always required, never
 * defaulted.
 */
export function fixtureEvent(input: FixtureEventInput, month: string, line: number, position = line): EventRecord {
  const candidate = {
    ts: "2026-01-01T00:00:00Z",
    id: fixedEventId(defaultIdCounter++),
    actor: "claude-code:alice/wt-auth",
    ...input,
  };
  const result = parseEvent(JSON.stringify(candidate));
  if (!result.ok) {
    throw new Error(`fixtureEvent: invalid fixture candidate: ${JSON.stringify(result.error)}`);
  }
  return { event: result.event, month, line, position };
}

/** The subset of `TicketFrontmatter` a fixture ticket typically needs to vary. */
export interface StoredTicketOverrides {
  readonly title?: string;
  readonly cankan?: CankanBlock;
}

/** A `StoredTicket` built directly from a `TicketFrontmatter` value — never via `parseTicketFile` (Ruling R11: this module's `Depends on` excludes `ticket/`, including from its tests). */
export function makeStoredTicket(id: string, status: string, overrides: StoredTicketOverrides = {}): StoredTicket {
  const frontmatter: TicketFrontmatter = {
    id: id as TicketId,
    title: overrides.title ?? `Title for ${id}`,
    status,
    ...(overrides.cankan !== undefined ? { cankan: overrides.cankan } : {}),
  };
  const path = `/fake/board/tickets/${id}.md`;
  const ticket: ParsedTicket = {
    frontmatter,
    source: { raw: `---\nid: ${id}\ntitle: ${frontmatter.title}\nstatus: ${status}\n---\n`, path },
  };
  return { id: id as TicketId, path, ticket };
}
