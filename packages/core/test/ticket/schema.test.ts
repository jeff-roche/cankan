import { describe, expect, test } from "bun:test";
import { ticketFrontmatterSchema } from "../../src/ticket/schema";

describe("ticketFrontmatterSchema", () => {
  test("requires only id, title and status", () => {
    const result = ticketFrontmatterSchema.safeParse({
      id: "ck-1",
      title: "x",
      status: "To Do",
    });
    expect(result.success).toBe(true);
  });

  test("fails without id/title/status", () => {
    expect(ticketFrontmatterSchema.safeParse({}).success).toBe(false);
    expect(ticketFrontmatterSchema.safeParse({ id: "ck-1" }).success).toBe(false);
    expect(ticketFrontmatterSchema.safeParse({ id: "ck-1", title: "x" }).success).toBe(false);
  });

  test("brands id as TicketId on the way out", () => {
    const result = ticketFrontmatterSchema.parse({ id: "ck-1", title: "x", status: "To Do" });
    // Compile-time brand only — at runtime this is just the string.
    expect(result.id as string).toBe("ck-1");
  });

  test("the cankan: block is fully optional, and so is every field inside it (ADR 0002 decision point 3)", () => {
    const withoutCankan = ticketFrontmatterSchema.safeParse({
      id: "ck-1",
      title: "x",
      status: "To Do",
    });
    expect(withoutCankan.success).toBe(true);
    if (withoutCankan.success) {
      expect(withoutCankan.data.cankan).toBeUndefined();
    }

    const withEmptyCankan = ticketFrontmatterSchema.safeParse({
      id: "ck-1",
      title: "x",
      status: "To Do",
      cankan: {},
    });
    expect(withEmptyCankan.success).toBe(true);

    const withPartialCankan = ticketFrontmatterSchema.safeParse({
      id: "ck-1",
      title: "x",
      status: "To Do",
      cankan: { sync: { state: "ahead" } },
    });
    expect(withPartialCankan.success).toBe(true);
  });

  test("passes through fields it does not know about, at every object level", () => {
    const result = ticketFrontmatterSchema.parse({
      id: "ck-1",
      title: "x",
      status: "To Do",
      a_future_backlog_field: "some value",
      cankan: { a_future_cankan_field: "another value" },
    });
    // biome-ignore lint/suspicious/noExplicitAny: asserting passthrough of a key the schema does not declare.
    expect((result as any).a_future_backlog_field).toBe("some value");
    // biome-ignore lint/suspicious/noExplicitAny: same, one level deeper.
    expect((result.cankan as any)?.a_future_cankan_field).toBe("another value");
  });
});
