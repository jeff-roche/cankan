/**
 * Error codes specific to the `ticket/` module.
 *
 * These live here rather than in the shared `src/errors.ts` — that file is
 * frozen except for appended lines, and `packages/core/test/index.test.ts`
 * asserts the root export key set exactly, so a code that belongs to one
 * module's own domain stays in that module's folder (see M2.1's
 * `src/errors.ts` file comment).
 */
export const TicketErrorCodes = {
  /**
   * `matter()`'s language-engine gate rejected the frontmatter, or the
   * frontmatter's language tag could not be resolved at all. Raised for
   * every error `matter()` throws — engine-not-registered (the intended
   * outcome of the `{ engines: { javascript: undefined } }` mitigation) and
   * any other error the call surfaces. The third-party error is passed as
   * `cause`, never copied into `message`/`details`.
   */
  FRONTMATTER_REJECTED: "TICKET_FRONTMATTER_REJECTED",
  /**
   * The frontmatter block is not well-formed: missing opening/closing
   * delimiters, invalid YAML, a YAML **alias** reference (`*name` —
   * rejected outright as a policy constraint, not a parse failure;
   * Backlog.md never emits one, and a bare anchor with no alias is left
   * alone), or a third-party failure converting an otherwise-valid document
   * to a plain object. Reported as path + line/col only where available —
   * never the parser's own message, which quotes the offending source line
   * verbatim (yaml@2.9.0's `YAMLParseError`) and could leak ticket content.
   */
  FRONTMATTER_MALFORMED: "TICKET_FRONTMATTER_MALFORMED",
  /**
   * The frontmatter parsed as YAML but failed schema validation (e.g. a
   * missing `id`/`title`/`status`). zod never echoes input values in its
   * issue messages, so those are safe to surface.
   */
  FRONTMATTER_INVALID: "TICKET_FRONTMATTER_INVALID",
  /**
   * The raw file or its frontmatter segment exceeded a size bound enforced
   * before the expensive parse step runs. `yaml@2.9.0`'s frontmatter parser
   * is at-least-quadratic in key count (measured: an 874 KB flat-key
   * frontmatter took ~40 s), so an unbounded parse is a shared-board denial
   * of service from one committed file — bounded here, not by trusting
   * callers to keep files small.
   */
  FRONTMATTER_TOO_LARGE: "TICKET_FRONTMATTER_TOO_LARGE",
  /**
   * A ticket id or title could not be turned into a safe filename (path
   * separator, empty result, `.`/`..`, whitespace, oversize, or an unsafe
   * character).
   */
  UNSAFE_FILENAME: "TICKET_UNSAFE_FILENAME",
} as const;
