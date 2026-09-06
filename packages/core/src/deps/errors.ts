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
 * Both codes below are **caller-programming-error** signals, not ordinary
 * "not ready" outcomes — `isReady` never returns a `ReadinessVerdict` with
 * `ready: false` for either condition, it throws. Neither is reachable
 * through this module's own `Depends on` (`state/` alone) misbehaving; both
 * exist because `isReady`'s options are caller-supplied (Ruling R6) and a
 * caller can misuse them.
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
   */
  EXCLUDED_LABELS_WITHOUT_LABELS_FOR: "DEPS_EXCLUDED_LABELS_WITHOUT_LABELS_FOR",
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
