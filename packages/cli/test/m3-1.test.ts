import { expect, test } from "bun:test";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { buildContext, contextSummary } from "../src/context";
import { createOutput } from "../src/output";
import { makeTempRepo } from "../../test-utils/src/tempRepo";
import { withEnv } from "../../test-utils/src/withEnv";

test("M3.1 resolves a repo context and git actor fallback", async () => {
  const repo = await makeTempRepo();
  try {
    await mkdir(join(repo.dir, ".cankan"));
    await withEnv(undefined, async () => {
      const context = await buildContext({ cwd: repo.dir, json: true });
      try {
        expect(context.board.root).toBe(repo.dir);
        expect(context.actor.id).toBe("CanKan Test");
        expect(context.actor.source).toBe("git");
        expect(contextSummary(context).output).toEqual({ mode: "json", quiet: false, verbose: false });
      } finally {
        context.core.dispose();
      }
    });
  } finally {
    await repo.cleanup();
  }
});

test("M3.1 output renders JSON and plain values", () => {
  const lines: string[] = [];
  createOutput({ json: true, write: (line) => lines.push(line) }).write({ ok: true });
  expect(lines).toEqual(['{"ok":true}']);

  const plain: string[] = [];
  createOutput({ plain: true, write: (line) => plain.push(line) }).write("ready");
  expect(plain).toEqual(["ready"]);
});
