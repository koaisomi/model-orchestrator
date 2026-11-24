import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { runPipeline } from "../src/orchestrator.mjs";
import { createMockProvider } from "../src/providers/mock.mjs";
import { createAnthropicProvider } from "../src/providers/anthropic.mjs";
import { createGates } from "../src/gates.mjs";
import { loadConfig } from "../src/config.mjs";
import { renderReport, buildReport } from "../src/report.mjs";

const config = loadConfig({ env: {} });
const HERE = path.dirname(fileURLToPath(import.meta.url));
const BIN = path.join(HERE, "..", "bin", "orchestrate.mjs");
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "orch-e2e-"));

const run = (task, { script, approve = [], provider, ...o } = {}) =>
  runPipeline({ task, provider: provider ?? createMockProvider({ script }), config, gates: createGates({ isTTY: false, approve }), runsDir: tmp(), root: tmp(), dryRun: true, assistClassify: false, ...o });
const kinds = (r) => r.steps.filter((s) => s.kind !== "local").map((s) => s.kind);
const events = (r, dir) => fs.readFileSync(path.join(dir, r.runId, "events.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));

const finding = (severity, category = "correctness") => ({ severity, category, file: "x.js", description: `${severity} problem`, fix: "fix it" });
const auditFail = (...f) => ({ verdict: "FAIL", summary: "bad", findings: f });

test("L1: build + basic check, PASS exit 0, MOCK banner, mock never reports a served model", async () => {
  const r = await run("fix typo in README");
  assert.equal(r.status, "PASS");
  assert.equal(r.exitCode, 0);
  assert.equal(r.state, "CLOSED");
  assert.deepEqual(kinds(r), ["build", "quickcheck"]);
  for (const s of r.steps.filter((x) => x.kind !== "local")) {
    assert.equal(s.provider, "mock");
    assert.equal(s.servedModel, "mock");
    assert.ok(s.requestedModel.startsWith("claude-"));
  }
  const text = renderReport(r);
  assert.match(text, /MOCK RUN — no model was called/);
  assert.match(text, /basic verification only: not an independent audit/);
  assert.equal(buildReport(r).banner, "MOCK RUN — no model was called");
});

test("L1: failed basic check -> FAIL exit 1", async () => {
  const r = await run("fix typo", { script: { quickcheck: [{ ok: false, issues: ["wrong word"] }] } });
  assert.equal(r.status, "FAIL");
  assert.equal(r.exitCode, 1);
});

test("L3: plan, build, audit FAIL -> one correction round -> PASS, validate", async () => {
  const r = await run("design the database schema", { script: { audit: [auditFail(finding("High")), { verdict: "PASS", summary: "ok", findings: [] }] } });
  assert.equal(r.status, "PASS");
  assert.equal(r.corrections, 1);
  assert.deepEqual(kinds(r), ["plan", "build", "audit", "build", "audit", "validation"]);
  assert.equal(r.finalRound, 2);
  assert.ok(r.steps.some((s) => s.phase.startsWith("correct")));
});

test("independence: auditor gets a fresh history with the actual proposal contents", async () => {
  const mock = createMockProvider({ script: { build: [{ summary: "S", planFlaw: false, planFlawReason: "", files: [{ path: "a.js", action: "create", content: "UNIQUE_PROPOSAL_BODY_123" }], testsSuggested: [], limitations: [] }] } });
  await run("design the database schema", { provider: mock });
  const audit = mock.calls.find((c) => c.kind === "audit");
  assert.equal(audit.messages.length, 1);
  assert.match(audit.messages[0].content, /UNIQUE_PROPOSAL_BODY_123/);
  assert.match(audit.messages[0].content, /HAND-OFF/);
  const build = mock.calls.find((c) => c.kind === "build");
  assert.notEqual(audit.system, build.system);
  const val = mock.calls.find((c) => c.kind === "validation");
  assert.match(val.messages[0].content, /UNIQUE_PROPOSAL_BODY_123/);
});

test("audit FAIL after max rounds -> status FAIL exit 1, escalated to human", async () => {
  const r = await run("design the database schema", { script: { audit: [auditFail(finding("Critical"))] }, maxRounds: 2 });
  assert.equal(r.status, "FAIL");
  assert.equal(r.exitCode, 1);
  assert.equal(r.corrections, 2);
  assert.equal(r.state, "ESCALATED");
  assert.match(r.blockReason, /unresolved after 2 correction/);
  assert.ok(r.escalations.some((e) => e.to === "human"));
  assert.ok(!kinds(r).includes("validation"));
});

test("Medium-only findings do not block; they travel to the validator", async () => {
  const r = await run("design the database schema", { script: { audit: [auditFail(finding("Medium"))] } });
  assert.equal(r.status, "PASS");
  assert.equal(r.corrections, 0);
  assert.equal(r.findings.length, 1);
});

test("L4 without approval: BLOCKED exit 2 at APPROVAL_REQUIRED, validator never ran", async () => {
  const r = await run("add login and password reset");
  assert.equal(r.classification.level, 4);
  assert.equal(r.status, "BLOCKED");
  assert.equal(r.exitCode, 2);
  assert.equal(r.blockedAt, "APPROVAL_REQUIRED");
  assert.ok(!kinds(r).includes("validation"));
  assert.equal(r.approvals[0].approved, false);
  assert.match(renderReport(r), /BLOCKED at APPROVAL_REQUIRED/);
});

test("L4 with --approve level4 passes and logs the approval", async () => {
  const dir = tmp();
  const r = await run("add login and password reset", { approve: ["level4"], runsDir: dir });
  assert.equal(r.status, "PASS");
  assert.equal(r.approvals[0].mode, "pre-approved");
  assert.ok(events(r, dir).some((e) => e.type === "gate" && e.approved === true));
});

test("builder planFlaw -> back to planner once (re-plan event), then continues", async () => {
  const flawed = { summary: "s", planFlaw: true, planFlawReason: "spec impossible", files: [], testsSuggested: [], limitations: [] };
  const ok = { summary: "s", planFlaw: false, planFlawReason: "", files: [{ path: "a.txt", action: "create", content: "x" }], testsSuggested: [], limitations: [] };
  const dir = tmp();
  const r = await run("design the database schema", { script: { build: [flawed, ok] }, runsDir: dir });
  assert.equal(r.status, "PASS");
  assert.equal(r.replans, 1);
  assert.deepEqual(kinds(r).slice(0, 4), ["plan", "build", "plan", "build"]);
  assert.ok(events(r, dir).some((e) => e.type === "escalation" && e.to === "planner"));
  // a second flaw does not loop forever
  const r2 = await run("design the database schema", { script: { build: [flawed] } });
  assert.equal(r2.replans, 1);
  assert.ok(r2.unverified.some((u) => /plan flaw/.test(u)));
});

test("auditor architecture finding (High) -> planner re-plan, then rebuild", async () => {
  const r = await run("design the database schema", { script: { audit: [auditFail(finding("High", "architecture")), { verdict: "PASS", summary: "ok", findings: [] }] } });
  assert.equal(r.status, "PASS");
  assert.equal(r.replans, 1);
  assert.deepEqual(kinds(r), ["plan", "build", "audit", "plan", "build", "audit", "validation"]);
});

test("L2: risk low skips audit, medium audits; retrieve only with context", async () => {
  const a = await run("build the features");
  assert.deepEqual(kinds(a), ["build", "validation"]);
  assert.match(a.unverified.join("\n"), /No audit ran/);
  const b = await run("add endpoint for users");
  assert.deepEqual(kinds(b), ["build", "audit", "validation"]);
  const root = tmp();
  fs.writeFileSync(path.join(root, "a.js"), "x");
  const c = await run("add endpoint for users", { root, context: ["a.js"] });
  assert.deepEqual(kinds(c), ["extraction", "build", "audit", "validation"]);
});

test("--level override is a recorded decision", async () => {
  const dir = tmp();
  const r = await run("fix typo", { levelOverride: 3, runsDir: dir });
  assert.equal(r.classification.level, 3);
  assert.match(fs.readFileSync(path.join(dir, r.runId, "decisions.md"), "utf8"), /level override 1 -> 3/);
});

test("validator FAIL -> FAIL; validator BLOCKED -> BLOCKED; PARTIAL -> exit 3", async () => {
  const f = await run("design the database schema", { script: { validation: [{ verdict: "FAIL", reasons: ["no"], unverified: [] }] } });
  assert.equal(f.exitCode, 1);
  const b = await run("design the database schema", { script: { validation: [{ verdict: "BLOCKED", reasons: ["need input"], unverified: [] }] } });
  assert.equal(b.exitCode, 2);
  const p = await run("design the database schema", { script: { validation: [{ verdict: "PARTIAL", reasons: ["half"], unverified: ["perf"] }] } });
  assert.equal(p.exitCode, 3);
  assert.equal(p.status, "PARTIAL");
  assert.ok(p.unverified.includes("validator: perf"));
});

test("no provider configured: BLOCKED, zero model steps, never fake success", async () => {
  const none = tmp();
  const provider = createAnthropicProvider({ config, env: { APPDATA: none, HOME: none, USERPROFILE: none } });
  assert.equal((await provider.capabilityCheck()).available, false);
  const r = await run("fix typo", { provider, dryRun: false });
  assert.equal(r.status, "BLOCKED");
  assert.equal(r.exitCode, 2);
  assert.equal(r.steps.length, 0);
  assert.match(r.blockReason, /not available/);
  assert.match(r.blockReason, /No model was called/);
  assert.equal(r.mock, false);
  assert.ok(!/MOCK RUN/.test(renderReport(r).split("\n")[0]));
});

test("budget: worst case above remaining -> BLOCKED before the call", async () => {
  const calls = [];
  const provider = { name: "anthropic", costsMoney: true, capabilityCheck: async () => ({ available: true, reason: "t" }), complete: async (q) => { calls.push(q); throw new Error("must not be called"); } };
  const r = await run("fix typo", { provider, budgetUsd: 0.001, dryRun: false });
  assert.equal(r.status, "BLOCKED");
  assert.match(r.blockReason, /budget/);
  assert.equal(calls.length, 0);
});

test("cost tracked at the served model price; substitution disclosed in report", async () => {
  const resp = { text: "", usage: { inputTokens: 1_000_000, outputTokens: 0, cacheRead: 0, cacheWrite: 0 }, provider: "anthropic", requestedModel: "claude-fable-5-2", servedModel: "claude-opus-5-5", stopReason: "end_turn", fallbackRan: false, substitution: { from: "claude-fable-5-2", to: "claude-opus-5-5", reason: "not-found" } };
  const provider = {
    name: "anthropic", costsMoney: true, capabilityCheck: async () => ({ available: true, reason: "t" }),
    complete: async (q) => ({ ...resp, text: JSON.stringify({ summary: "s", spec: "sp", acceptanceCriteria: ["a"], risks: [], humanQuestions: [] }) }),
  };
  // only the planner kind: stop after plan by making build throw a structured failure
  const r = await run("design the database schema", { provider: { ...provider, complete: async (q) => (q.kind === "plan" ? provider.complete(q) : { ...resp, text: "garbage" }) }, dryRun: false });
  const plan = r.steps.find((s) => s.kind === "plan");
  assert.equal(plan.servedModel, "claude-opus-5-5");
  assert.ok(Math.abs(plan.usd - 4) < 1e-9); // opus price, not fable
  assert.match(renderReport(r), /SUBSTITUTED claude-fable-5-2 -> claude-opus-5-5/);
  assert.equal(r.status, "FAIL"); // garbage build output
});

test("nothing is written outside the run folder by a run", async () => {
  const runs = tmp();
  const root = tmp();
  fs.writeFileSync(path.join(root, "README.md"), "a greating");
  const before = fs.readFileSync(path.join(root, "README.md"), "utf8");
  await run("fix typo in README", { runsDir: runs, root, context: ["README.md"] });
  assert.equal(fs.readFileSync(path.join(root, "README.md"), "utf8"), before);
  assert.deepEqual(fs.readdirSync(root), ["README.md"]);
});

test("secrets in task and context never reach the provider", async () => {
  const root = tmp();
  fs.writeFileSync(path.join(root, "c.txt"), "password=TOPSECRET9 and Authorization: Bearer CTXTOKEN7");
  const mock = createMockProvider();
  await run("fix typo; key sk-ant-abcdefghijklmnop1234", { provider: mock, root, context: ["c.txt"] });
  const all = JSON.stringify(mock.calls);
  for (const s of ["TOPSECRET9", "CTXTOKEN7", "sk-ant-abcdefghijklmnop1234"]) assert.ok(!all.includes(s), s);
});

/** Offline whatever the machine: empty HOME/USERPROFILE/APPDATA/LOCALAPPDATA, no credentials, no claude binary. */
function offlineEnv(runsDir, extra = {}) {
  const home = tmp();
  const e = { ...process.env, HOME: home, USERPROFILE: home, APPDATA: home, LOCALAPPDATA: home, ORCH_RUNS_DIR: runsDir, ORCH_CLAUDE_BIN: path.join(home, "no-such-claude.exe"), ...extra };
  for (const k of Object.keys(e)) if (/^ANTHROPIC_/.test(k)) delete e[k];
  return e;
}

function cli(args, env = {}) {
  const runsDir = tmp();
  const r = spawnSync(process.execPath, [BIN, ...args], { encoding: "utf8", env: offlineEnv(runsDir, env), timeout: 120000 });
  return { ...r, runsDir };
}

test("CLI acceptance 3: typo dry-run on sample project -> MOCK banner, exit 0, run folder written", () => {
  const r = cli(["run", "fix typo in README", "--dry-run", "--root", path.join(HERE, "..", "examples", "sample-project")]);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /MOCK RUN — no model was called/);
  const ids = fs.readdirSync(r.runsDir);
  assert.equal(ids.length, 1);
  for (const f of ["events.jsonl", "decisions.md", "changelog.md", "run.json"]) assert.ok(fs.existsSync(path.join(r.runsDir, ids[0], f)), f);
});

test("CLI acceptance 4: auth task dry-run without approval -> exit 2 BLOCKED at APPROVAL_REQUIRED", () => {
  const r = cli(["run", "add login and password reset for users", "--dry-run"]);
  assert.equal(r.status, 2, r.stdout + r.stderr);
  assert.match(r.stdout, /BLOCKED at APPROVAL_REQUIRED/);
  const r2 = cli(["run", "add login and password reset for users", "--dry-run", "--approve", "level4"]);
  assert.equal(r2.status, 0);
});

test("CLI: doctor without credentials reports BLOCKED honestly and exits 0; bad usage exits 4", () => {
  const d = cli(["doctor"]);
  assert.equal(d.status, 0);
  assert.match(d.stdout, /anthropic\s+BLOCKED: no credentials/);
  assert.match(d.stdout, /claude-cli\s+BLOCKED: claude binary not found/); // machine independent: no binary in the offline env
  assert.equal(cli([]).status, 4);
  assert.equal(cli(["run"]).status, 4);
  assert.equal(cli(["run", "x", "--level", "abc"]).status, 4);
  assert.equal(cli(["run", "x", "--approve", "bogus", "--dry-run"]).status, 4);
  assert.equal(cli(["nope"]).status, 4);
  const real = cli(["run", "fix typo", "--provider", "anthropic"]); // no --dry-run, no credentials
  assert.equal(real.status, 2);
  assert.match(real.stdout, /not available/);
  const dflt = cli(["run", "fix typo"]); // default provider is claude-cli; no binary in the offline env
  assert.equal(dflt.status, 2);
  assert.match(dflt.stdout, /provider "claude-cli" not available/);
  assert.ok(!/MOCK RUN/.test(real.stdout));
});

test("CLI: status/report/runs/apply round trip on a dry run", () => {
  const first = cli(["run", "fix typo in README", "--dry-run"]);
  const id = fs.readdirSync(first.runsDir)[0];
  const env = { ORCH_RUNS_DIR: first.runsDir };
  const run = (a) => spawnSync(process.execPath, [BIN, ...a], { encoding: "utf8", env: offlineEnv(first.runsDir) });
  assert.match(run(["status", id]).stdout, /PASS.*\(MOCK\)/);
  assert.match(run(["report", id]).stdout, /MODEL ROUTING/);
  assert.equal(JSON.parse(run(["report", id, "--json"]).stdout).banner, "MOCK RUN — no model was called");
  assert.match(run(["runs"]).stdout, new RegExp(id));
  const target = tmp();
  // mock runs are never applied, with or without the gate
  for (const extra of [[], ["--approve", "apply"]]) {
    const r = run(["apply", id, "--target", target, ...extra]);
    assert.equal(r.status, 2);
    assert.match(r.stderr, /mock provider/);
    assert.deepEqual(fs.readdirSync(target), []);
  }
});
