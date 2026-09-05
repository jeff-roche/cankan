/**
 * Public surface of the git adapter (M2.6). See `adapter.ts` for the
 * implementation and `docs/decisions/0001-coordination-ref.md:336-693` for
 * the specification this module implements.
 */

export { createGitAdapter } from "./adapter";
export { GitErrorCodes } from "./errors";
export { validateCoordinationRef } from "./refValidation";
export type { CasAttemptResult, CasRetryOptions } from "./retry";
export { withCasRetry } from "./retry";
export type {
  CasOutcome,
  CommitTreeFile,
  CommitTreeParams,
  GitAdapter,
  GitAdapterOptions,
  ObjectSha,
  RefSha,
  Sha,
  SyncOutcome,
  WorktreeInfo,
} from "./types";
