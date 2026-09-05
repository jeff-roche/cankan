#!/usr/bin/env bun
/**
 * Parses PLAN.md's task sections into GitHub issues (one per task, one
 * tracking issue per milestone), idempotently, per docs/issue-conventions.md.
 *
 * Usage:
 *   bun scripts/plan-to-issues.ts --dry-run   # read-only, prints the diff
 *   bun scripts/plan-to-issues.ts             # creates/updates for real
 */

import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const PLAN_PATH = new URL("../PLAN.md", import.meta.url).pathname;

function matchIndex(m: RegExpMatchArray): number {
  if (m.index === undefined)
    throw new Error(`Regex match had no index: ${m[0]}`);
  return m.index;
}

function lastSegment(path: string): string {
  const segment = path.trim().split("/").pop();
  if (!segment)
    throw new Error(`Could not read the last "/"-segment of "${path}"`);
  return segment;
}

function mustGet<K, V>(map: Map<K, V>, key: K): V {
  const value = map.get(key);
  if (value === undefined)
    throw new Error(`Expected a value for key "${String(key)}"`);
  return value;
}

interface Field {
  label: string;
  text: string;
}

interface Task {
  id: string; // "M2.7"
  title: string; // "Event log" (backticks stripped)
  milestone: string; // "M2"
  wire: boolean;
  fields: Field[]; // Creates/Wires/Done when/extras, in document order (never "Depends on")
  dependsOn: string[]; // task ids parsed from the "Depends on" field
}

interface Milestone {
  id: string; // "M0"
  title: string; // "Repository and toolchain"
}

// ---------- gh helpers ----------

function gh(args: string[]): string {
  const result = Bun.spawnSync(["gh", ...args], {
    stdout: "pipe",
    stderr: "pipe",
  });
  if (result.exitCode !== 0) {
    throw new Error(
      `gh ${args.join(" ")} failed:\n${result.stderr.toString()}`,
    );
  }
  return result.stdout.toString();
}

/**
 * Assign a milestone by its numeric id via the REST API.
 *
 * `gh issue edit --milestone <title>` resolves the title against *open*
 * milestones only, so it fails with "'M0' not found" once a milestone is
 * completed. The number always resolves.
 */
function setMilestone(repo: string, issue: number, milestone: number): void {
  gh([
    "api",
    "-X",
    "PATCH",
    `repos/${repo}/issues/${issue}`,
    "-F",
    `milestone=${milestone}`,
    "--silent",
  ]);
}

function repoNameWithOwner(): string {
  return gh([
    "repo",
    "view",
    "--json",
    "nameWithOwner",
    "-q",
    ".nameWithOwner",
  ]).trim();
}

// ---------- parsing ----------

function parseCriticalPath(planText: string): Set<string> {
  const match = planText.match(/## Critical path\n\n(.+)\n/);
  if (!match) throw new Error("Could not find the critical path line");
  const ids = new Set<string>();
  for (const rawToken of match[1].split("→")) {
    const token = rawToken.replace(/\*\*/g, "").trim();
    for (const part of token.split("/")) {
      const id = part.trim().split(/\s/)[0]; // drop trailing "(...)" notes
      if (/^(M\d+|MB)\.\d+$/.test(id)) ids.add(id);
    }
  }
  return ids;
}

function parseFields(block: string): Field[] {
  const lines = block.split("\n");
  const fields: Field[] = [];
  let current: Field | null = null;
  const fieldStart = /^- \*\*([^*:]+):\*\*\s?(.*)$/;

  for (const line of lines) {
    const m = line.match(fieldStart);
    if (m) {
      if (current) fields.push({ ...current, text: current.text.trim() });
      current = { label: m[1].trim(), text: m[2] };
    } else if (current) {
      current.text += `\n${line}`;
    }
  }
  if (current) fields.push({ ...current, text: current.text.trim() });
  return fields;
}

function parsePlan(planText: string): {
  milestones: Milestone[];
  tasks: Task[];
} {
  const milestones: Milestone[] = [];
  const tasks: Task[] = [];

  const sectionRe = /^## (M\d+|MB) — (.+)$/gm;
  const sectionMatches = [...planText.matchAll(sectionRe)];

  for (let s = 0; s < sectionMatches.length; s++) {
    const [, milestoneId, milestoneTitle] = sectionMatches[s];
    milestones.push({ id: milestoneId, title: milestoneTitle.trim() });

    const sectionStart =
      matchIndex(sectionMatches[s]) + sectionMatches[s][0].length;
    const sectionEnd =
      s + 1 < sectionMatches.length
        ? matchIndex(sectionMatches[s + 1])
        : planText.indexOf("\n## Critical path");
    const sectionBody = planText.slice(sectionStart, sectionEnd);

    const taskRe = /^### (.+)$/gm;
    const taskMatches = [...sectionBody.matchAll(taskRe)];
    for (let t = 0; t < taskMatches.length; t++) {
      const headingLine = taskMatches[t][1];
      const blockStart = matchIndex(taskMatches[t]) + taskMatches[t][0].length;
      const blockEnd =
        t + 1 < taskMatches.length
          ? matchIndex(taskMatches[t + 1])
          : sectionBody.length;
      const block = sectionBody.slice(blockStart, blockEnd);

      const fields = parseFields(block);
      const dependsField = fields.find((f) => f.label === "Depends on");
      const dependsOn = dependsField
        ? [...dependsField.text.matchAll(/(M\d+|MB)\.\d+/g)].map((m) => m[0])
        : [];
      const bodyFields = fields.filter((f) => f.label !== "Depends on");

      // A heading may name more than one task: "M6.4 GitHub backer / M6.5 Jira backer"
      for (const part of headingLine.split(" / ")) {
        const idMatch = part.match(
          /^((?:M\d+|MB)\.\d+)\s+(?:\[wire\]\s+)?(.*)$/,
        );
        if (!idMatch)
          throw new Error(
            `Could not parse task heading part: "${part}" (from "${headingLine}")`,
          );
        const [, id, rawTitle] = idMatch;
        tasks.push({
          id,
          title: rawTitle.replace(/`/g, "").trim(),
          milestone: milestoneId,
          wire: part.includes("[wire]"),
          fields: bodyFields,
          dependsOn,
        });
      }
    }
  }

  return { milestones, tasks };
}

function classify(
  task: Task,
  criticalPath: Set<string>,
): { priority: "P0" | "P1" | "P2"; type: "wire" | "spike" | "docs" | "piece" } {
  const priority = criticalPath.has(task.id) ? "P0" : task.wire ? "P1" : "P2";

  let type: "wire" | "spike" | "docs" | "piece" = "piece";
  if (task.wire) {
    type = "wire";
  } else {
    const creates = task.fields.find((f) => f.label === "Creates")?.text ?? "";
    if (creates.includes("spikes/")) {
      type = "spike";
    } else {
      const paths = [...creates.matchAll(/`([^`]+)`/g)].map((m) => m[1]);
      const pathLike = paths.filter((p) => p.includes("/") || p.includes("."));
      if (pathLike.length > 0 && pathLike.every((p) => p.startsWith("docs/")))
        type = "docs";
    }
  }
  return { priority, type };
}

// ---------- body rendering ----------

function renderTaskBody(
  task: Task,
  idToIssue: Map<string, number>,
  milestoneIssue: number,
): string {
  const sections = task.fields
    .map((f) => `## ${f.label}\n${f.text}`)
    .join("\n\n");
  const deps =
    task.dependsOn.length === 0
      ? "none"
      : task.dependsOn
          .map((id) =>
            idToIssue.has(id) ? `#${idToIssue.get(id)}` : `UNRESOLVED:${id}`,
          )
          .join(", ");
  return `${sections}\n\nDepends on: ${deps}\nPart of: #${milestoneIssue}\n`;
}

function renderMilestoneBody(
  milestone: Milestone,
  tasks: Task[],
  idToIssue: Map<string, number>,
  closedIssues: Set<number>,
): string {
  const items = tasks
    .filter((t) => t.milestone === milestone.id)
    .map((t) => {
      const num = idToIssue.get(t.id);
      // Closed issue = task done (see docs/issue-conventions.md), so the box
      // reflects issue state rather than being reset to unchecked on every sync.
      const box = num !== undefined && closedIssues.has(num) ? "[x]" : "[ ]";
      return `- ${box} ${num ? `#${num}` : "(pending)"} \`${t.id}\` ${t.title}`;
    })
    .join("\n");
  return `## Tasks\n${items}\n`;
}

// ---------- labels & milestones ----------

const LABELS: { name: string; color: string; description: string }[] = [
  { name: "P0", color: "b60205", description: "Critical path" },
  { name: "P1", color: "d93f0b", description: "Wire/integration task" },
  { name: "P2", color: "fbca04", description: "Everything else" },
  { name: "P3", color: "0e8a16", description: "Low priority" },
  {
    name: "in-progress",
    color: "1d76db",
    description: "Claimed and being worked",
  },
  { name: "in-review", color: "5319e7", description: "PR open, in review" },
  {
    name: "piece",
    color: "c5def5",
    description: "Creates a new piece of the system",
  },
  {
    name: "wire",
    color: "f9d0c4",
    description: "Integration task connecting existing pieces",
  },
  { name: "spike", color: "bfd4f2", description: "Throwaway exploratory work" },
  { name: "docs", color: "0075ca", description: "Documentation only" },
];

function ensureLabels(repo: string, dryRun: boolean, existing: Set<string>) {
  for (const label of LABELS) {
    if (existing.has(label.name)) continue;
    console.log(`+ label ${label.name}`);
    if (!dryRun) {
      gh([
        "label",
        "create",
        label.name,
        "--repo",
        repo,
        "--color",
        label.color,
        "--description",
        label.description,
        "--force",
      ]);
    }
  }
}

function ensureMilestones(
  repo: string,
  milestones: Milestone[],
  dryRun: boolean,
  existing: Map<string, number>,
) {
  for (const m of milestones) {
    if (existing.has(m.id)) continue;
    console.log(`+ milestone [${m.id}] ${m.title}`);
    if (!dryRun) {
      const out = gh([
        "api",
        `repos/${repo}/milestones`,
        "-f",
        `title=${m.id}`,
        "-f",
        `description=${m.title}`,
        "-q",
        ".number",
      ]);
      existing.set(m.id, Number.parseInt(out.trim(), 10));
    }
  }
}

// ---------- main ----------

function main() {
  const dryRun = process.argv.includes("--dry-run");
  const planText = readFileSync(PLAN_PATH, "utf8");
  const { milestones, tasks } = parsePlan(planText);
  const criticalPath = parseCriticalPath(planText);

  console.log(`Parsed ${milestones.length} milestones, ${tasks.length} tasks.`);

  const repo = repoNameWithOwner();

  // Existing state (read-only; safe in dry-run too).
  const existingLabelsRaw = JSON.parse(
    gh(["label", "list", "--repo", repo, "--json", "name", "--limit", "200"]),
  ) as { name: string }[];
  const existingLabels = new Set(existingLabelsRaw.map((l) => l.name));
  // state=all: the API lists only open milestones by default, so a completed
  // milestone would look absent and be re-created (422, and the sync dies
  // before the body-rewrite pass).
  const existingMilestonesRaw: { title: string; number: number }[] = JSON.parse(
    gh([
      "api",
      `repos/${repo}/milestones?state=all`,
      "--paginate",
      "-q",
      "[.[] | {title,number}]",
    ]) || "[]",
  );
  const existingMilestones = new Map(
    existingMilestonesRaw.map((m) => [m.title, m.number]),
  );

  const existingIssuesRaw: { number: number; title: string; state: string }[] =
    JSON.parse(
      gh([
        "issue",
        "list",
        "--repo",
        repo,
        "--state",
        "all",
        "--json",
        "number,title,state",
        "--limit",
        "500",
      ]),
    );
  const idToIssue = new Map<string, number>();
  const closedIssues = new Set<number>();
  for (const issue of existingIssuesRaw) {
    const m = issue.title.match(/^\[((?:M\d+|MB)(?:\.\d+)?)\]/);
    if (m) idToIssue.set(m[1], issue.number);
    if (issue.state.toUpperCase() === "CLOSED") closedIssues.add(issue.number);
  }

  ensureLabels(repo, dryRun, existingLabels);
  ensureMilestones(repo, milestones, dryRun, existingMilestones);

  // Pass 1: create/update title + labels + milestone for every issue (tracking, then task).
  for (const m of milestones) {
    const title = `[${m.id}] ${m.title}`;
    if (idToIssue.has(m.id)) {
      console.log(`= tracking issue ${title} (#${idToIssue.get(m.id)})`);
      if (!dryRun) {
        gh([
          "issue",
          "edit",
          String(idToIssue.get(m.id)),
          "--repo",
          repo,
          "--title",
          title,
        ]);
        setMilestone(
          repo,
          mustGet(idToIssue, m.id),
          mustGet(existingMilestones, m.id),
        );
      }
    } else {
      console.log(`+ tracking issue ${title}`);
      if (!dryRun) {
        const url = gh([
          "issue",
          "create",
          "--repo",
          repo,
          "--title",
          title,
          "--body",
          "_(pending)_",
        ]);
        const num = Number.parseInt(lastSegment(url), 10);
        idToIssue.set(m.id, num);
        setMilestone(repo, num, mustGet(existingMilestones, m.id));
      }
    }
  }

  for (const task of tasks) {
    const { priority, type } = classify(task, criticalPath);
    const title = `[${task.id}] ${task.title}`;
    const labels = [priority, type];
    if (idToIssue.has(task.id)) {
      console.log(
        `= ${title} (#${idToIssue.get(task.id)}) [${labels.join(", ")}] milestone=${task.milestone}`,
      );
      if (!dryRun) {
        gh([
          "issue",
          "edit",
          String(idToIssue.get(task.id)),
          "--repo",
          repo,
          "--title",
          title,
          "--add-label",
          labels.join(","),
        ]);
        setMilestone(
          repo,
          mustGet(idToIssue, task.id),
          mustGet(existingMilestones, task.milestone),
        );
      }
    } else {
      console.log(
        `+ ${title} [${labels.join(", ")}] milestone=${task.milestone} depends-on=${task.dependsOn.join(",") || "none"}`,
      );
      if (!dryRun) {
        const url = gh([
          "issue",
          "create",
          "--repo",
          repo,
          "--title",
          title,
          "--body",
          "_(pending)_",
          "--label",
          labels.join(","),
        ]);
        const num = Number.parseInt(lastSegment(url), 10);
        idToIssue.set(task.id, num);
        setMilestone(repo, num, mustGet(existingMilestones, task.milestone));
      }
    }
  }

  if (dryRun) {
    console.log(
      "\n--dry-run: no writes performed. Re-run without --dry-run to create/update for real.",
    );
    return;
  }

  // Pass 2: now that every id has an issue number, write real bodies.
  const bodyDir = mkdtempSync(join(tmpdir(), "cankan-plan-to-issues-"));
  for (const task of tasks) {
    const body = renderTaskBody(
      task,
      idToIssue,
      mustGet(idToIssue, task.milestone),
    );
    const bodyPath = join(bodyDir, `${task.id.replace("/", "-")}.md`);
    writeFileSync(bodyPath, body);
    gh([
      "issue",
      "edit",
      String(idToIssue.get(task.id)),
      "--repo",
      repo,
      "--body-file",
      bodyPath,
    ]);
  }
  for (const m of milestones) {
    const body = renderMilestoneBody(m, tasks, idToIssue, closedIssues);
    const bodyPath = join(bodyDir, `${m.id}.md`);
    writeFileSync(bodyPath, body);
    gh([
      "issue",
      "edit",
      String(idToIssue.get(m.id)),
      "--repo",
      repo,
      "--body-file",
      bodyPath,
    ]);
  }

  // Pin the M0 tracking issue.
  gh(["issue", "pin", String(idToIssue.get("M0")), "--repo", repo]);

  const unresolved = tasks.flatMap((t) =>
    t.dependsOn.filter((d) => !idToIssue.has(d)),
  );
  if (unresolved.length > 0) {
    console.error(
      `Unresolved dependency ids: ${[...new Set(unresolved)].join(", ")}`,
    );
    process.exitCode = 1;
  }

  console.log(
    `\nDone. ${milestones.length} milestone issues, ${tasks.length} task issues.`,
  );
}

// Without this, a throw inside main() still leaves the process exiting 0 — a
// half-finished sync (pass 1 applied, bodies not) reporting success.
try {
  main();
} catch (err) {
  console.error(err);
  process.exit(1);
}
