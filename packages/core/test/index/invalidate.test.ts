import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { openIndex } from "../../src/index/db";
import { createIndexInvalidator, ensureIndexFresh, computeIndexValidity, isIndexStale, queryTicketsFresh, readIndexValidity } from "../../src/index/invalidate";
import { queryTickets } from "../../src/index/query";
import { reindex } from "../../src/index/reindex";
import { makeTicket, sentinelState } from "./testHelpers";

describe("index invalidation", () => {
  test("mtime/ref marker detects an editor write and refreshes the next query", async () => {
    const root = await mkdtemp(join(tmpdir(), "cankan-index-invalidate-"));
    const ticketsDir = join(root, "tickets");
    await mkdir(ticketsDir);
    const ticket = join(ticketsDir, "CK-NEW.md");
    await writeFile(ticket, "---\nid: CK-NEW\nstatus: To Do\n---\noriginal\n");
    const index = openIndex({ boardKey: `invalidate-${root}`, env: { HOME: root } });
    const initial = { ...sentinelState("CK-NEW"), tickets: [makeTicket("CK-NEW")] };
    const initialValidity = await computeIndexValidity({ ticketsDir, readRef: async () => "abc" });
    reindex({ index, state: initial, validity: JSON.stringify(initialValidity) });
    expect(queryTickets(index)).toHaveLength(1);
    createIndexInvalidator(index)();
    expect(() => queryTickets(index)).toThrow(/stale/);

    await writeFile(ticket, "---\nid: CK-NEW\nstatus: Done\n---\nedited outside the API\n");
    const changed = await computeIndexValidity({ ticketsDir, readRef: async () => "abc" });
    expect(isIndexStale(index, changed)).toBe(true);

    const refreshed = await ensureIndexFresh({ index, ticketsDir, readRef: async () => "abc", fold: async () => {
      const source = await Bun.file(ticket).text();
      return { ...initial, tickets: [makeTicket("CK-NEW", { status: source.includes("status: Done") ? "Done" : "To Do" })] };
    } });
    expect(refreshed?.ticketCount).toBe(1);
    const result = await queryTicketsFresh({ index, ticketsDir, readRef: async () => "abc", fold: () => { throw new Error("fold should not run after refresh"); } });
    expect(result[0]?.status).toBe("Done");
    expect(readIndexValidity(index)?.refSha).toBe("abc");
    index.close();
  });

  test("fresh query avoids a rebuild when both inputs are unchanged", async () => {
    const root = await mkdtemp(join(tmpdir(), "cankan-index-fresh-"));
    const ticketsDir = join(root, "tickets");
    await mkdir(ticketsDir);
    const index = openIndex({ boardKey: `fresh-${root}`, env: { HOME: root } });
    const state = sentinelState();
    const validity = await computeIndexValidity({ ticketsDir, readRef: async () => null });
    reindex({ index, state, validity: JSON.stringify(validity) });
    const result = await queryTicketsFresh({ index, ticketsDir, readRef: async () => null, fold: () => { throw new Error("fold should not run"); } });
    expect(result).toEqual(queryTickets(index));
    index.close();
  });
});
