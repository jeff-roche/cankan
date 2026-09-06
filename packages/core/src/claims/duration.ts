/**
 * `claims/duration.ts` — converts a config-shaped duration string (e.g.
 * `claims.lease`'s `"2h"`) into a millisecond count. **There is no duration
 * parser anywhere else in this repo (confirmed by search)**: `config/schema.ts`'s
 * `durationSchema` validates a lease string's *shape* — the same
 * `/^\d+(ms|s|m|h|d|w)$/` pattern this module re-checks — but never converts
 * it to a number; `state/fold.ts`'s `ObserveAndFoldOptions.leaseTtlMs` is a
 * caller argument the fold never derives from config itself (Ruling R7).
 * This module is that missing conversion, owned by the one caller
 * (`claims/`) that actually needs a millisecond value from a duration
 * string.
 */

import { CanKanError } from "../errors";
import { ClaimErrorCodes } from "./errors";

const DURATION_PATTERN = /^(\d+)(ms|s|m|h|d|w)$/;

const UNIT_MS: Readonly<Record<string, number>> = {
  ms: 1,
  s: 1_000,
  m: 60_000,
  h: 3_600_000,
  d: 86_400_000,
  w: 604_800_000,
};

/**
 * One 30-day month, in milliseconds — the same unit `claim.ts`'s
 * `trailingMonths` derivation (`ceil(leaseTtlMs / 30 days) + 1`) uses.
 * Duplicated here (not imported) deliberately: this module must stay able
 * to reject an absurd lease **on its own**, independent of whichever
 * caller later derives a month count from the value it returns.
 */
const MONTH_MS = 30 * 24 * 60 * 60 * 1000;

/**
 * The largest `leaseTtlMs` this module will hand back — 119 of the 30-day
 * months above. Chosen so that `claim.ts`'s own
 * `clamp(max(2, ceil(leaseTtlMs / MONTH_MS) + 1), 1, 120)` formula lands
 * `trailingMonths` at *exactly* 120 (`ceil(119) + 1`) for a lease at this
 * bound, and never needs to silently clamp a larger value down — silently
 * truncating a configured lease's effective read window would misrepresent
 * expiry as a display fact instead of failing loudly at the one place that
 * knows the real number the caller asked for. A lease at or beyond ~9.8
 * years is already well past any real board's use, so failing loudly here
 * costs nothing a real config would ever hit.
 */
const MAX_LEASE_MS = 119 * MONTH_MS;

/**
 * Parses a duration string of the exact shape `config/schema.ts`'s
 * `claims.lease` accepts (`/^\d+(ms|s|m|h|d|w)$/` — digits, no sign, no
 * decimal, no whitespace, followed by exactly one of the six unit
 * suffixes) into a millisecond count.
 *
 * Rejects, all with `ClaimErrorCodes.INVALID_LEASE_DURATION`:
 * - anything not a `string` at all;
 * - anything not matching the pattern above (a negative number, a decimal,
 *   an unrecognized/uppercase unit, embedded whitespace, empty string, a
 *   value like `"1e3s"` that `Number()` would otherwise happily coerce);
 * - a result that is not a positive, finite number of milliseconds (`"0h"`
 *   parses to `0`, which is rejected the same way a negative or `NaN`
 *   result would be — a zero-length lease can never be a live lease, and
 *   would make every claim expire on arrival);
 * - a result exceeding `MAX_LEASE_MS` (an absurd, config-typo-shaped value
 *   like `"999999999w"` — see that constant's own doc comment for why the
 *   bound is exactly there).
 *
 * `details` never echoes the raw input string — it is either config content
 * or a caller-supplied `--lease` override, and this module holds to the
 * same "report which rule failed, never the value that failed it"
 * discipline `events/log.ts`'s own option validators use throughout,
 * regardless of whether the specific input happens to be sensitive.
 */
export function parseDurationMs(value: string): number {
  if (typeof value !== "string") {
    throw new CanKanError(
      ClaimErrorCodes.INVALID_LEASE_DURATION,
      `lease duration must be a string matching /^\\d+(ms|s|m|h|d|w)$/, got ${typeof value}`,
      { details: { type: typeof value } },
    );
  }
  const match = DURATION_PATTERN.exec(value);
  if (!match) {
    throw new CanKanError(
      ClaimErrorCodes.INVALID_LEASE_DURATION,
      "lease duration must match /^\\d+(ms|s|m|h|d|w)$/ (e.g. \"2h\")",
      { details: { reason: "malformed" } },
    );
  }
  const amount = Number(match[1]);
  const unit = match[2] as keyof typeof UNIT_MS;
  const ms = amount * UNIT_MS[unit];
  if (!Number.isFinite(ms) || ms <= 0) {
    throw new CanKanError(
      ClaimErrorCodes.INVALID_LEASE_DURATION,
      "lease duration must resolve to a positive, finite number of milliseconds",
      { details: { reason: "non-positive" } },
    );
  }
  if (ms > MAX_LEASE_MS) {
    throw new CanKanError(
      ClaimErrorCodes.INVALID_LEASE_DURATION,
      `lease duration must not exceed ${MAX_LEASE_MS}ms (~119 30-day months)`,
      { details: { reason: "too-large", maxMs: MAX_LEASE_MS } },
    );
  }
  return ms;
}
