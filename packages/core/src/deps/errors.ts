/**
 * Module-local error codes for `deps/` (M2.11, readiness and dependencies),
 * per `../errors.ts`'s file-level comment: `CanKanError.code` is a plain,
 * open `string`, and a code specific to one module's own domain is declared
 * in that module's own folder rather than in the shared `errors.ts` —
 * mirroring `state/errors.ts`, `store/errors.ts` and `events/errors.ts`.
 * The original brief's rule 2 says the same thing directly: a `deps/`-local
 * code for `deps/`'s own condition is fine; the shared `errors.ts` is not
 * the place for it.
 *
 * **Prefixed `DEPS_`**, following `state/`'s and `store/`'s convention.
 *
 * Every code below is a **caller-programming-error** signal, not an ordinary
 * "not ready" outcome — `isReady` never returns a `ReadinessVerdict` with
 * `ready: false` for any of these, it throws. None is reachable through this
 * module's own `Depends on` (`state/` alone) misbehaving; all three exist
 * because `isReady`'s options are caller-supplied (Ruling R6) and a caller
 * can misuse them.
 */
export const DepsErrorCodes = {
  /**
   * `IsReadyOptions.excludedLabels` was non-empty but `labelsFor` was not
   * supplied (fix round 1, Ruling R11's companion guard). Without a
   * `labelsFor` lookup, no ticket's labels can ever be checked against
   * `excludedLabels`, so every `"excluded-label"` reason silently never
   * fires — the same "a default that can be silently wrong is worse than a
   * required argument" failure class `flatDependenciesFor`'s own
   * required-ness exists to close. `excludedLabels` absent or empty with
   * `labelsFor` absent stays legal (there is nothing to exclude, so nothing
   * to silently miss).
   *
   * Thrown by **both** `isReady` and `readySet` (fix round 2, Ruling R23):
   * `readySet` validates this once, unconditionally, before its per-ticket
   * sweep — not only via `isReady`'s own copy of the same check — because an
   * **empty** board's sweep never calls `isReady` at all (the loop body
   * never runs), which previously let this exact misconfiguration pass
   * `readySet` silently, returning an empty-but-valid-looking result instead
   * of throwing.
   */
  EXCLUDED_LABELS_WITHOUT_LABELS_FOR: "DEPS_EXCLUDED_LABELS_WITHOUT_LABELS_FOR",
  /**
   * `isReady` (or `readySet`, which validates the same options up front) was
   * called without a well-formed `options` argument — either `options`
   * itself is missing (`undefined`/`null`), or `options.flatDependenciesFor`
   * is not a function (fix round 2, Ruling R28). TypeScript already makes
   * both a compile error at every in-repo call site (`flatDependenciesFor`
   * has been required since fix round 1, Ruling R11), but a JS caller
   * unguarded by the type system previously got a bare, uncoded `TypeError`
   * from `options.excludedLabels` a few lines into `isReady`'s body instead
   * of a diagnosable error naming exactly what was missing — the same
   * "coded error over an engine crash" discipline Ruling R15's cast-removal
   * already established for this module.
   */
  IS_READY_OPTIONS_REQUIRED: "DEPS_IS_READY_OPTIONS_REQUIRED",
  /**
   * `isReady` called `state.blockedBy(state, ticketId)` and it returned
   * without throwing — which, by contract 3 and Ruling R2, should guarantee
   * exactly one entry in `state.tickets` matches `ticketId`'s normalized
   * form, resolved the identical way `blockedBy` resolves its own subject
   * (an own-id `.filter`, `state/queries.ts:275` — not
   * `buildIdentifierIndex`) — but no such entry was found (fix round 1,
   * Ruling R15). Today this is unreachable: verified directly against the
   * real `blockedBy`. It exists so that if `state/` ever widens
   * `blockedBy`'s own subject resolution without a matching change here,
   * the failure is this coded, diagnosable error instead of an uncaught
   * `TypeError` from an unchecked cast.
   */
  BLOCKED_BY_SUBJECT_LOOKUP_INVARIANT_VIOLATED: "DEPS_BLOCKED_BY_SUBJECT_LOOKUP_INVARIANT_VIOLATED",
} as const;
