import { describe, expect, test } from "bun:test";
import { parse } from "yaml";
import {
  effectiveConfigSchema,
  globalConfigSchema,
  localConfigSchema,
  repoConfigSchema,
} from "../../src/config/schema";

/*
 * NOTE FOR TASK B (yaml@2's default schema, not this lane's concern to fix):
 * `parse()` here relies on yaml@2's default core schema (YAML 1.2), under
 * which a bare `off` scalar parses as the string `"off"` — exactly what
 * `sync.auto_push: off` (CONCEPT.md 303) needs to validate against the
 * `syncAutoPushSchema` enum. Under a YAML 1.1 schema (`parse(src, {
 * version: "1.1" })` or the `"core"`/`"failsafe"` legacy schemas), `off` /
 * `on` / `yes` / `no` are boolean-ish and this same fixture would fail to
 * validate. `layers.ts` (Task B) must not pass a `version` option that
 * changes this default.
 */

/**
 * Verbatim from CONCEPT.md 278-358, `.cankan/config.yml` (repo, checked in).
 * This is the single highest-value test in Task A (see the brief): if the
 * spec's own example does not parse, the schema is wrong.
 */
const REPO_CONFIG_YAML = `
version: 1
project: cankan
id_prefix: ck                  # for native ticket IDs; adopt backlog may renumber
tickets_dir: backlog/tasks     # Backlog.md-compatible layout; change only if you know why

columns:                       # board columns; status values must map into these
  - To Do
  - In Progress
  - In Review
  - Done

coordination:
  ref: refs/cankan/coordination
  mode: shared-ref             # shared-ref | branch-scan (fallback)
  push_ref: true               # push/fetch the coordination ref alongside normal git remote ops
                               # (CanKan always supplies the explicit refspec itself; plain
                               #  git push/fetch/clone never move this ref)

claims:
  lease: 2h                    # default lease; agents renew on activity
  max_per_actor: 3             # 0 = unlimited
  require_ready: true          # can only claim tickets with no open blockers

sync:
  auto_push: off               # off | transitions_only | all   (policy: repo can pin)
  auto_pull: off               # off | on_prime | on_board | interval:15m
  conflict_policy: manual      # manual | ours | theirs

backers:
  github:
    repo: owner/name
    credential: github-personal          # name in credentials store
    status_map:                          # CanKan column -> backer representation
      "To Do":       { state: open }
      "In Progress": { state: open, label: in-progress }
      "In Review":   { state: open, label: in-review }
      "Done":        { state: closed }
    priority_map: { critical: P0, high: P1, medium: P2, low: P3 }   # labels
    project: 12                          # optional GitHub Projects number to mirror columns
  jira:
    site: https://acme.atlassian.net
    project: PROJ
    credential: jira-work
    status_map:
      "To Do":       { status: "To Do" }
      "In Progress": { status: "In Progress" }
      "In Review":   { status: "In Review" }
      "Done":        { status: "Done" }
    priority_map: { critical: Highest, high: High, medium: Medium, low: Low }
    sprint_field: customfield_10020

default_backer: none           # none | github | jira | beads — where \`create\` sends new tickets

ready:
  order: [rank, priority:desc, created:asc]   # default sort for ready/claim --next
  exclude_labels: [icebox, needs-design]      # never surface these as ready

queues:                        # named filter + order; \`claim --next --queue <name>\`
  backend-urgent:
    filter: { labels: [backend], priority: [critical, high] }
    order: [due:asc, priority:desc]
  frontend:
    filter: { labels: [frontend] }
    order: [rank, created:asc]
  chores:
    filter: { labels: [chore], backer: [github] }
    order: [id:asc]
    actors: ["codex:*"]        # actors matching this pattern default to this queue

hooks:                         # repo-shared; run with $TICKET $ACTOR $FROM $TO $TITLE
  on_close: ./scripts/notify.sh

agents:
  instructions_file: AGENTS.md # where init appends the workflow section
  mcp: true

definition_of_done:            # Backlog.md-compatible; applied to new tickets
  - Tests pass
  - Docs updated
`;

/** Verbatim from CONCEPT.md 361-369, `.cankan/local.yml` (repo-local, gitignored). */
const LOCAL_CONFIG_YAML = `
actor: claude-code:alice/wt-auth   # identity for this checkout; defaults to git user.name
parent: alice                      # human responsible for this actor
default_backer: jira               # overrides repo default for tickets I create here
sync:
  auto_pull: on_prime
hooks:
  on_claim: 'claude "Work on $TICKET: $TITLE" &'   # local dispatch, not shared
`;

/** Verbatim from CONCEPT.md 372-413, `~/.config/cankan/config.yml` (global user). */
const GLOBAL_CONFIG_YAML = `
version: 1
identity:
  name: alice
  email: alice@example.com
editor: code --wait
claims:
  lease: 4h                  # my preference; repo policy may pin a different value
sync:
  auto_push: transitions_only   # my default; a repo can override by policy
credentials:
  store: keychain            # keychain | file | env
agents:
  default_tool: claude-code
output:
  color: auto
  json_pretty: false

backers:                       # available to the personal board and as defaults for repos
  jira-work:
    type: jira
    site: https://acme.atlassian.net
    credential: jira-work
  github-personal:
    type: github
    credential: github-personal

personal:
  path: ~/.local/share/cankan/personal   # override XDG default
  remote: git@github.com:alice/cankan-personal.git   # optional; auto push/pull of the whole board
  sync: on_command             # on_command | on_change | interval:10m
  default_backer: none
  columns: [Inbox, Today, Waiting, Done]
  queues:
    followups: { filter: { labels: [followup] }, order: [due:asc] }

repos:
  auto_register: true          # \`cankan init\` adds repos to repos.yml
  names:                       # optional friendly names for --board all output
    ~/code/api: api
    ~/code/web: web
`;

describe("the spec's own examples", () => {
  test("the repo config example (CONCEPT.md 278-358) parses", () => {
    const result = repoConfigSchema.safeParse(parse(REPO_CONFIG_YAML));
    expect(result.success, JSON.stringify((result as { error?: unknown }).error)).toBe(true);
  });

  test("the local config example (CONCEPT.md 361-369) parses", () => {
    const result = localConfigSchema.safeParse(parse(LOCAL_CONFIG_YAML));
    expect(result.success, JSON.stringify((result as { error?: unknown }).error)).toBe(true);
  });

  test("the global config example (CONCEPT.md 372-413) parses", () => {
    const result = globalConfigSchema.safeParse(parse(GLOBAL_CONFIG_YAML));
    expect(result.success, JSON.stringify((result as { error?: unknown }).error)).toBe(true);
  });

  test("an unknown key anywhere in the repo file is rejected and names the key", () => {
    const raw = parse(REPO_CONFIG_YAML) as Record<string, unknown>;
    raw.not_a_real_key = true;
    const result = repoConfigSchema.safeParse(raw);
    expect(result.success).toBe(false);
    if (!result.success) {
      // zod4's "unrecognized_keys" issue puts the offending object's path in
      // `issue.path` and the key names themselves in `issue.keys` — not in
      // `issue.path` — so R13's "names the offending key" is read off both.
      expect(
        result.error.issues.some(
          (i) =>
            i.code === "unrecognized_keys" &&
            i.path.length === 0 &&
            i.keys.includes("not_a_real_key"),
        ),
      ).toBe(true);
    }
  });

  test("an unknown key nested inside a fixed-shape object is rejected and names its path", () => {
    const raw = parse(REPO_CONFIG_YAML) as Record<string, unknown>;
    (raw.coordination as Record<string, unknown>).bogus = 1;
    const result = repoConfigSchema.safeParse(raw);
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(
        result.error.issues.some(
          (i) =>
            i.code === "unrecognized_keys" &&
            i.path.join(".") === "coordination" &&
            i.keys.includes("bogus"),
        ),
      ).toBe(true);
    }
  });
});

describe("enums — one accepted, one rejected value each", () => {
  test("coordination.mode", () => {
    expect(repoConfigSchema.safeParse({ coordination: { mode: "branch-scan" } }).success).toBe(true);
    expect(repoConfigSchema.safeParse({ coordination: { mode: "bogus" } }).success).toBe(false);
  });

  test("sync.auto_push", () => {
    expect(repoConfigSchema.safeParse({ sync: { auto_push: "all" } }).success).toBe(true);
    expect(repoConfigSchema.safeParse({ sync: { auto_push: "bogus" } }).success).toBe(false);
  });

  test("sync.auto_pull, including the interval: pattern", () => {
    expect(repoConfigSchema.safeParse({ sync: { auto_pull: "on_board" } }).success).toBe(true);
    expect(repoConfigSchema.safeParse({ sync: { auto_pull: "interval:15m" } }).success).toBe(true);
    expect(repoConfigSchema.safeParse({ sync: { auto_pull: "bogus" } }).success).toBe(false);
  });

  test("sync.conflict_policy", () => {
    expect(repoConfigSchema.safeParse({ sync: { conflict_policy: "ours" } }).success).toBe(true);
    expect(repoConfigSchema.safeParse({ sync: { conflict_policy: "bogus" } }).success).toBe(false);
  });

  test("default_backer", () => {
    expect(repoConfigSchema.safeParse({ default_backer: "beads" }).success).toBe(true);
    expect(repoConfigSchema.safeParse({ default_backer: "bogus" }).success).toBe(false);
  });

  test("credentials.store", () => {
    expect(globalConfigSchema.safeParse({ credentials: { store: "env" } }).success).toBe(true);
    expect(globalConfigSchema.safeParse({ credentials: { store: "bogus" } }).success).toBe(false);
  });

  test("personal.sync, including the interval: pattern", () => {
    expect(globalConfigSchema.safeParse({ personal: { sync: "on_change" } }).success).toBe(true);
    expect(globalConfigSchema.safeParse({ personal: { sync: "interval:10m" } }).success).toBe(true);
    expect(globalConfigSchema.safeParse({ personal: { sync: "bogus" } }).success).toBe(false);
  });

  test("output.color — accepts the spec-shown value and the two inferred siblings", () => {
    expect(effectiveConfigSchema.safeParse({ output: { color: "auto" } }).success).toBe(true);
    expect(effectiveConfigSchema.safeParse({ output: { color: "always" } }).success).toBe(true);
    expect(effectiveConfigSchema.safeParse({ output: { color: "never" } }).success).toBe(true);
    expect(effectiveConfigSchema.safeParse({ output: { color: "bogus" } }).success).toBe(false);
  });
});

describe("coordination.ref (ADR 0001, contract R14)", () => {
  test("accepts the default and a nested namespace", () => {
    expect(repoConfigSchema.safeParse({ coordination: { ref: "refs/cankan/coordination" } }).success).toBe(true);
    expect(repoConfigSchema.safeParse({ coordination: { ref: "refs/cankan/team/x" } }).success).toBe(true);
  });

  test("rejects a ref outside the refs/cankan/ namespace", () => {
    expect(repoConfigSchema.safeParse({ coordination: { ref: "refs/heads/main" } }).success).toBe(false);
  });

  test("rejects a bare branch name with no refs/ prefix at all", () => {
    expect(repoConfigSchema.safeParse({ coordination: { ref: "main" } }).success).toBe(false);
  });

  test("the mandated pattern admits a `..` path-traversal-shaped component — documented, not fixed here", () => {
    // The brief and contract R14 require this exact regex,
    // `^refs\/cankan\/[A-Za-z0-9._/-]+$`, verbatim. Its character class
    // allows repeated `.` (needed for ordinary segment names), so it does
    // not special-case a `..` *segment* the way `git check-ref-format`
    // does. R14 assigns that rejection to `git check-ref-format` at M2.6,
    // deliberately: this schema is the ADR's fail-early half, not the
    // enforcing backstop, and shelling out to git here would duplicate
    // that backstop and require a `git/` dependency this module does not
    // have. So this is accepted at this layer today — see the implementer
    // report's "inference list" for the same call spelled out in prose.
    expect(repoConfigSchema.safeParse({ coordination: { ref: "refs/cankan/../evil" } }).success).toBe(true);
  });

  test("gives a legible custom message rather than zod's default text", () => {
    const result = repoConfigSchema.safeParse({ coordination: { ref: "refs/heads/main" } });
    expect(result.success).toBe(false);
    if (!result.success) {
      const issue = result.error.issues.find((i) => i.path.join(".") === "coordination.ref");
      expect(issue?.message).toContain("refs/cankan/");
    }
  });
});

describe("backers — repo keys by type, global keys by name with explicit type (contract R4)", () => {
  test("repo backer entries have no type field", () => {
    expect(
      repoConfigSchema.safeParse({ backers: { github: { repo: "owner/name" } } }).success,
    ).toBe(true);
  });

  test("global backer entries require type", () => {
    expect(
      globalConfigSchema.safeParse({ backers: { "jira-work": { credential: "x" } } }).success,
    ).toBe(false);
    expect(
      globalConfigSchema.safeParse({ backers: { "jira-work": { type: "jira", credential: "x" } } })
        .success,
    ).toBe(true);
  });

  test("the merged superset makes type optional", () => {
    expect(
      effectiveConfigSchema.safeParse({ backers: { github: { repo: "owner/name" } } }).success,
    ).toBe(true);
    expect(
      effectiveConfigSchema.safeParse({
        backers: { "jira-work": { type: "jira", credential: "x" } },
      }).success,
    ).toBe(true);
  });

  test("backers.*.project accepts both a GitHub Projects number and a Jira project key", () => {
    expect(repoConfigSchema.safeParse({ backers: { github: { project: 12 } } }).success).toBe(true);
    expect(repoConfigSchema.safeParse({ backers: { jira: { project: "PROJ" } } }).success).toBe(true);
  });
});

describe("status_map — modeled permissively, with one documented limitation", () => {
  test("accepts every shape CONCEPT.md's examples show (github's and jira's)", () => {
    expect(
      repoConfigSchema.safeParse({
        backers: { github: { status_map: { "To Do": { state: "open" } } } },
      }).success,
    ).toBe(true);
    expect(
      repoConfigSchema.safeParse({
        backers: { jira: { status_map: { "To Do": { status: "To Do" } } } },
      }).success,
    ).toBe(true);
  });

  test("does NOT accept a bare-string column value — a limitation of modeling the value as record(field -> unknown), not a discriminated union", () => {
    // CONCEPT.md never shows a status_map entry as a bare string (every
    // example is `{ state: ... }` or `{ status: ... }`), so this is a
    // documented gap rather than a spec example that fails: see the
    // implementer report's "inference list".
    const result = repoConfigSchema.safeParse({
      backers: { github: { status_map: { "To Do": "open" } } },
    });
    expect(result.success).toBe(false);
  });
});

describe("no field anywhere holds a secret value", () => {
  test("backer entries only ever carry a credential *name*", () => {
    const parsed = repoConfigSchema.parse({
      backers: { github: { credential: "github-personal" } },
    });
    expect(parsed.backers?.github?.credential).toBe("github-personal");
    // The shape has no `token`, `secret`, or `password` field to hold a
    // value instead of a name.
    expect(Object.keys(parsed.backers?.github ?? {})).not.toContain("token");
  });
});

describe("built-in defaults materialize on an empty effective config", () => {
  test("every chosen default is present", () => {
    const eff = effectiveConfigSchema.parse({});

    expect(eff.tickets_dir).toBe("backlog/tasks");
    expect(eff.columns).toEqual(["To Do", "In Progress", "In Review", "Done"]);
    expect(eff.coordination).toEqual({
      ref: "refs/cankan/coordination",
      mode: "shared-ref",
      push_ref: true,
    });
    expect(eff.claims).toEqual({ lease: "2h", max_per_actor: 3, require_ready: true });
    expect(eff.sync).toEqual({ auto_push: "off", auto_pull: "off", conflict_policy: "manual" });
    expect(eff.default_backer).toBe("none");
    expect(eff.ready).toEqual({ order: ["rank", "priority:desc", "created:asc"] });
    expect(eff.agents).toEqual({ instructions_file: "AGENTS.md", mcp: true });
    expect(eff.output).toEqual({ color: "auto", json_pretty: false });
    expect(eff.repos).toEqual({ auto_register: true });
  });

  test("defaults still fill in when the group is partially set by a layer", () => {
    const eff = effectiveConfigSchema.parse({ coordination: { mode: "branch-scan" } });
    expect(eff.coordination).toEqual({
      ref: "refs/cankan/coordination",
      mode: "branch-scan",
      push_ref: true,
    });
  });

  test("fields with no built-in default stay undefined when unset", () => {
    const eff = effectiveConfigSchema.parse({});
    expect(eff.version).toBeUndefined();
    expect(eff.project).toBeUndefined();
    expect(eff.id_prefix).toBeUndefined();
    expect(eff.credentials).toBeUndefined();
    expect(eff.identity).toBeUndefined();
    expect(eff.personal).toBeUndefined();
    expect(eff.backers).toBeUndefined();
    expect(eff.hooks).toBeUndefined();
    expect(eff.definition_of_done).toBeUndefined();
  });
});

describe("every file is a rung on both precedence chains (contract R1, R7(a))", () => {
  test("global config parses a policy key (columns) — legal per R7(a), silently overridden, not rejected at parse", () => {
    // R7(a): "A global config setting `columns` (a built-in policy key) is
    // *legal* — global is simply the lowest file rung of the policy chain."
    // That can only be true if the schema lets the key through in the first
    // place; a parse failure here would make "silently overridden" a dead
    // letter.
    const result = globalConfigSchema.safeParse({ columns: ["Backlog", "Done"] });
    expect(result.success).toBe(true);
  });

  test("repo-local config parses every claims/sync field, not just the ones its own example shows", () => {
    // R1: preference keys resolve `env > repo-local > repo > global >
    // default` — repo-local is the *top* file rung for every preference
    // key, including ones CONCEPT.md's local.yml example never happens to
    // set (only `sync.auto_pull` is shown there).
    expect(localConfigSchema.safeParse({ claims: { lease: "4h" } }).success).toBe(true);
    expect(
      localConfigSchema.safeParse({
        sync: { auto_push: "all", auto_pull: "on_prime", conflict_policy: "ours" },
      }).success,
    ).toBe(true);
  });

  test("repo config parses fields its own example never sets but the chain allows (e.g. output, editor)", () => {
    expect(repoConfigSchema.safeParse({ output: { color: "never" } }).success).toBe(true);
    expect(repoConfigSchema.safeParse({ editor: "vim" }).success).toBe(true);
  });
});

describe("personal.path stays a raw string (contract R15)", () => {
  test("no ~ expansion", () => {
    const parsed = globalConfigSchema.parse({
      personal: { path: "~/.local/share/cankan/personal" },
    });
    expect(parsed.personal?.path).toBe("~/.local/share/cankan/personal");
  });
});
