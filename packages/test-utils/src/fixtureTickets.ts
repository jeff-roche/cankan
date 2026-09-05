import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

export interface FixtureTicket {
  id: string;
  title: string;
  status: string;
  body: string;
}

export interface FixtureTicketOverrides {
  id?: string;
  title?: string;
  status?: string;
  body?: string;
}

/**
 * Generates plain fixture ticket objects. Deliberately independent of
 * `@jeff-roche/cankan-core`'s ticket schema (not created until M2.2) - just enough
 * shape for tests that need *some* tickets to exist.
 */
export function makeFixtureTickets(
  count = 3,
  overrides: FixtureTicketOverrides[] = [],
): FixtureTicket[] {
  return Array.from({ length: count }, (_, i) => {
    const n = i + 1;
    const override = overrides[i] ?? {};
    return {
      id: override.id ?? `ck-fixture${String(n).padStart(3, "0")}`,
      title: override.title ?? `Fixture ticket ${n}`,
      status: override.status ?? "To Do",
      body: override.body ?? `Body text for fixture ticket ${n}.`,
    };
  });
}

function slugify(title: string): string {
  return title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/(^-|-$)/g, "");
}

/** Writes fixture tickets as Backlog.md-style `<id> - <slug>.md` files under `dir`. */
export async function writeFixtureTickets(
  dir: string,
  tickets: FixtureTicket[],
): Promise<string[]> {
  await mkdir(dir, { recursive: true });
  const paths: string[] = [];
  for (const ticket of tickets) {
    const filename = `${ticket.id} - ${slugify(ticket.title)}.md`;
    const path = join(dir, filename);
    const content = `---\nid: ${ticket.id}\ntitle: ${ticket.title}\nstatus: ${ticket.status}\n---\n\n${ticket.body}\n`;
    await writeFile(path, content, "utf8");
    paths.push(path);
  }
  return paths;
}
