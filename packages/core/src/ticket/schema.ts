import { z } from "zod";
import type { TicketId } from "../types";

/**
 * The zod schema for a ticket's frontmatter — Backlog.md's own fields
 * (CONCEPT.md "Ticket file", ~line 432) plus CanKan's `cankan:` block.
 *
 * This schema validates a **derived view** of the frontmatter for callers
 * that want a typed object; it never owns the bytes written back to disk.
 * `ticket/frontmatter.ts` keeps the original raw text alongside this parsed
 * value and re-emits unchanged regions verbatim — see its file comment.
 *
 * `.passthrough()` at every object level: a future Backlog.md field, or any
 * key this schema does not yet know about, must survive in the *parsed
 * view* too, not just in the raw bytes — dropping it here would make the
 * derived view lie about what the file actually contains.
 *
 * Only `id`, `title` and `status` are required. Every other Backlog.md
 * field is optional because a hand-written or minimal ticket may omit it.
 * The whole `cankan:` block, and every field inside it, is optional: ADR
 * 0002 decision point 3 established that `backlog task edit` deletes the
 * entire block on any edit, so it is a **disposable cache**, never durable
 * storage. A ticket file whose `cankan:` block Backlog.md just destroyed
 * must still parse cleanly — making any field inside it required would
 * break that on the very next foreign edit.
 */

const cankanSyncSchema = z
  .object({
    /** clean | ahead | behind | diverged | conflict (CONCEPT.md's `sync.state`). */
    state: z.string().optional(),
    base_hash: z.string().optional(),
    pulled_at: z.string().optional(),
    url: z.string().optional(),
  })
  .passthrough();

const cankanDepSchema = z
  .object({
    type: z.string(),
    id: z.string(),
  })
  .passthrough();

const cankanBlockSchema = z
  .object({
    /** Omitted for native tickets (CONCEPT.md's ticket-file example). */
    origin: z.string().optional(),
    display_id: z.string().optional(),
    sync: cankanSyncSchema.optional(),
    deps: z.array(cankanDepSchema).optional(),
    /** Previous IDs, filled by adopt/renumber. */
    aliases: z.array(z.string()).optional(),
  })
  .passthrough();

export const ticketFrontmatterSchema = z
  .object({
    /** Branded on the way out — see `src/types.ts` and M2.1's zod note: `.brand<>()` is structurally incompatible with the `__brand` shape used here. */
    id: z
      .string()
      .min(1)
      .transform((s) => s as TicketId),
    title: z.string().min(1),
    status: z.string().min(1),
    assignee: z.array(z.string()).optional(),
    labels: z.array(z.string()).optional(),
    milestone: z.string().optional(),
    priority: z.string().optional(),
    /** Manual rank; Backlog.md's own field. */
    ordinal: z.number().optional(),
    due_date: z.string().optional(),
    dependencies: z.array(z.string()).optional(),
    created_date: z.string().optional(),
    updated_date: z.string().optional(),
    cankan: cankanBlockSchema.optional(),
  })
  .passthrough();

/** The validated, derived view of a ticket's frontmatter. Not the bytes. */
export type TicketFrontmatter = z.infer<typeof ticketFrontmatterSchema>;

export type CankanBlock = z.infer<typeof cankanBlockSchema>;
