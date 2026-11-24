// Regression tests for audit fix round 1 (one block per finding number).
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import Anthropic from "@anthropic-ai/sdk";
import { safeJoin, isDeniedPath, hasShortName } from "../src/paths.mjs";
import { retrieve, RetrieveError } from "../src/retrieve.mjs";
import { redact } from "../src/redact.mjs";
import { classify } from "../src/classify.mjs";
import { route } from "../src/router.mjs";
import { runPipeline } from "../src/orchestrator.mjs";
import { createMockProvider } from "../src/providers/mock.mjs";
import { createClaudeCliProvider, cliArgs, pickServedModel } from "../src/providers/claude-cli.mjs";
import { createAnthropicProvider } from "../src/providers/anthropic.mjs";
import { supportsServerFallbacks } from "../src/models.mjs";
import { createGates } from "../src/gates.mjs";
import { createLedger, newRunId } from "../src/ledger.mjs";
import { applyRun, executableWarning, printable } from "../src/apply.mjs";
import { stepCost } from "../src/cost.mjs";
import { renderReport } from "../src/report.mjs";
import { createState } from "../src/state.mjs";
import { loadConfig } from "../src/config.mjs";

const config = loadConfig({ env: {} });
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "orch-fix-"));
const kinds = (r) => r.steps.filter((s) => s.kind !== "local").map((s) => s.kind);
const run = (task, { script, approve = [], provider, ...o } = {}) =>
  runPipeline({ task, provider: provider ?? createMockProvider({ script }), config, gates: createGates({ isTTY: false, approve }), runsDir: tmp(), root: tmp(), dryRun: true, assistClassify: false, ...o });

function finishedRun(files, extra = {}) {
  const runs = tmp();
  const id = newRunId();
  const l = createLedger(runs, id);
  l.saveProposal(1, { summary: "s", files, testsSuggested: [], limitations: [] });
  l.saveRun({ runId: id, status: "PASS", finalRound: 1, classification: { level: 1 }, ...extra });
  return { runs, id };
}

/** A hostile manifest: the ledger itself refuses unsafe paths, so write safe names and then rewrite the manifest. */
function hostile(paths) {
  const { runs, id } = finishedRun(paths.map((_, i) => ({ path: `safe${i}.txt`, action: "create", content: "x" })));
  const mf = path.join(runs, id, "proposals", "round-1", "manifest.json");
  const m = JSON.parse(fs.readFileSync(mf, "utf8"));
  m.files.forEach((x, i) => { x.path = paths[i]; });
  fs.writeFileSync(mf, JSON.stringify(m));
  return { runs, id };
}

// ---- 1. 8.3 short names, ADS colon, native realpath deny ----
test("fix1: 8.3 short-name segments rejected in apply paths and context paths", async () => {
  assert.ok(hasShortName("GIT~1/hooks/pre-commit"));
  assert.ok(!hasShortName("src/app.js"));
  assert.throws(() => safeJoin(tmp(), "GIT~1/hooks/pre-commit"), /8\.3 short-name/);
  assert.throws(() => safeJoin(tmp(), "PROGRA~1/x"), /8\.3/);
  const target = tmp();
  const { runs, id } = hostile(["GIT~1/hooks/pre-commit"]);
  await assert.rejects(applyRun({ runsDir: runs, runId: id, target, gates: createGates({ isTTY: false, approve: ["apply"] }) }), /8\.3 short-name/);
  assert.deepEqual(fs.readdirSync(target), []);
  const root = tmp();
  fs.mkdirSync(path.join(root, ".git"));
  assert.throws(() => retrieve(["GIT~1"], { root }), RetrieveError);
});

test("fix1: deny checks run on the native real path (a link named innocently that points into .git)", async (t) => {
  const target = tmp();
  fs.mkdirSync(path.join(target, ".git", "hooks"), { recursive: true });
  try { fs.symlinkSync(path.join(target, ".git"), path.join(target, "innocent"), "junction"); } catch { return t.skip("junction not permitted"); }
  const { runs, id } = finishedRun([{ path: "innocent/hooks/pre-commit", action: "create", content: "x" }]);
  await assert.rejects(applyRun({ runsDir: runs, runId: id, target, gates: createGates({ isTTY: false, approve: ["apply"] }) }), /protected/);
  assert.ok(!fs.existsSync(path.join(target, ".git", "hooks", "pre-commit")));
  const root = tmp();
  fs.mkdirSync(path.join(root, ".git"));
  fs.writeFileSync(path.join(root, ".git", "config"), "x");
  fs.symlinkSync(path.join(root, ".git"), path.join(root, "innocent"), "junction");
  assert.ok(!retrieve(["."], { root }).files.some((f) => f.path.includes("config")));
  assert.throws(() => retrieve(["innocent"], { root }), /protected/);
});

test("fix1: ':' in a context path (NTFS stream) rejected, including server.pem::$DATA", () => {
  const root = tmp();
  fs.writeFileSync(path.join(root, "server.pem"), "KEY");
  for (const p of ["server.pem::$DATA", "server.pem:stream", "a:b"]) assert.throws(() => retrieve([p], { root }), RetrieveError, p);
  assert.ok(isDeniedPath("server.pem::$DATA"));
  assert.ok(isDeniedPath("server.pem."));
});

// ---- 2. override may only raise; gate whenever critical ----
test("fix2: --level lowering is ignored; password task stays level 4 and is gated", async () => {
  const c = classify("add password reset to login", { levelOverride: 1 });
  assert.equal(c.level, 4);
  assert.equal(c.override, null);
  assert.deepEqual(c.overrideIgnored, { requested: 1, rulesLevel: 4 });
  const r = await run("add password reset to login", { levelOverride: 1 });
  assert.equal(r.status, "BLOCKED");
  assert.equal(r.blockedAt, "APPROVAL_REQUIRED");
  assert.ok(r.route.includes("audit") && r.route.includes("gate"));
  assert.ok(!kinds(r).includes("validation"));
  const ok = await run("add password reset to login", { levelOverride: 1, approve: ["level4"] });
  assert.equal(ok.status, "PASS");
  assert.ok(kinds(ok).includes("audit") && kinds(ok).includes("validation"));
});

test("fix2: router requires the gate when risk is critical or rules said level 4, whatever the level", () => {
  assert.ok(route(1, { risk: "critical" }).includes("gate"));
  assert.ok(route(2, { rulesLevel: 4 }).includes("gate"));
  assert.ok(!route(2, { risk: "low" }).includes("gate"));
});

// ---- 3. redaction ----
test("fix3: redaction covers JSON/YAML/header/URL/prefix forms and keeps normal prose", () => {
  const cases = [
    ['{"Authorization": "Basic dXNlcjpwYXNzd29yZA=="}', "dXNlcjpwYXNzd29yZA"],
    ["Authorization: Bearer abc", "abc"],
    ["x-api-key: abcd1234efgh", "abcd1234efgh"],
    ['api_key: "k-9f8e7d6c"', "k-9f8e7d6c"],
    ['{"password": "hunter2"}', "hunter2"],
    ["token: tok_live_12345", "tok_live_12345"],
    ["client_secret: s3cr3tvalue", "s3cr3tvalue"],
    ["DB_PASSWORD=p@ss1", "p@ss1"],
    ["postgres://admin:pw123@db.example.com/app", "pw123"],
    ["github_pat_11ABCDEFG0abcdefghij_klmnop", "11ABCDEFG0"],
    ["gho_abc123 ghu_def456 ghs_ghi789", "abc123"],
    ["gho_abc123 ghu_def456 ghs_ghi789", "def456"],
    ["gho_abc123 ghu_def456 ghs_ghi789", "ghi789"],
    ["AIzaSyA1234567890abcdefghijklmnopqrstuv", "A1234567890abcdefghij"],
    ["https://x.test/cb?token=tok123&ok=1", "tok123"],
  ];
  for (const [input, secret] of cases) assert.ok(!redact(input).includes(secret), `leaked ${secret} from ${input}`);
  assert.equal(redact("authorization is required for this route"), "authorization is required for this route");
  assert.equal(redact("the bearer of bad news said so"), "the bearer of bad news said so");
  assert.ok(redact("https://x.test/cb?token=tok123&ok=1").includes("ok=1"));
  assert.ok(redact("postgres://admin:pw123@db.example.com/app").includes("db.example.com/app"));
  console.log("--- redact() fix-round sample ---");
  for (const [input] of cases) console.log(JSON.stringify(input), "=>", JSON.stringify(redact(input)));
  console.log("--- end ---");
});

// ---- 4. deny list, explicit denied dir, junction loop ----
test("fix4: extra deny names", () => {
  for (const p of [".npmrc", "a/.netrc", "_netrc", ".git-credentials", ".pypirc", "id_ed25519", "id_ed25519.pub", "id_ecdsa", "terraform.tfstate", "x.tfstate.backup", ".htpasswd"]) assert.ok(isDeniedPath(p), p);
  assert.ok(!isDeniedPath("README.md"));
});

test("fix4: explicit denied dir or file context is refused, not skipped; junction loops end", (t) => {
  const root = tmp();
  fs.mkdirSync(path.join(root, ".git"));
  fs.mkdirSync(path.join(root, "node_modules"));
  fs.writeFileSync(path.join(root, ".npmrc"), "//registry:_authToken=zzz");
  for (const p of [".git", "node_modules", ".npmrc"]) assert.throws(() => retrieve([p], { root }), /protected/, p);
  fs.mkdirSync(path.join(root, "a"));
  fs.writeFileSync(path.join(root, "a", "f.txt"), "one");
  try { fs.symlinkSync(path.join(root, "a"), path.join(root, "a", "loop"), "junction"); } catch { return t.skip("junction not permitted"); }
  const r = retrieve(["."], { root });
  assert.equal(r.files.filter((f) => f.content === "one").length, 1);
});

// ---- 5. claude-cli isolation ----
function fakeSpawn(stdout) {
  const seen = {};
  const fn = (bin, args, opts) => {
    seen.args = args; seen.opts = opts; seen.cwdExistedAtStart = fs.existsSync(opts.cwd);
    const child = new EventEmitter();
    child.stdout = new PassThrough(); child.stderr = new PassThrough(); child.stdin = new PassThrough();
    child.kill = () => {};
    setImmediate(() => { child.stdout.end(stdout); child.emit("close", 0); });
    return child;
  };
  return { fn, seen };
}

test("fix5: claude-cli isolation flags, effort, empty temp cwd that is removed afterwards", async () => {
  assert.deepEqual(cliArgs("claude-haiku-5-5", "low"), ["-p", "--model", "claude-haiku-5-5", "--output-format", "json", "--tools", "", "--strict-mcp-config", "--setting-sources", "", "--disallowedTools", "mcp__*", "--no-session-persistence", "--effort", "low"]);
  const { fn, seen } = fakeSpawn(JSON.stringify({ result: "OK", modelUsage: { "claude-haiku-5-5": { inputTokens: 1, outputTokens: 1 } } }));
  await createClaudeCliProvider({ spawnFn: fn, bin: "claude" }).complete({ kind: "probe", model: "claude-haiku-5-5", effort: "low", system: "s", messages: [{ role: "user", content: "x" }] });
  assert.ok(seen.args.includes("--strict-mcp-config") && seen.args.includes("--no-session-persistence"));
  assert.equal(seen.args[seen.args.indexOf("--setting-sources") + 1], "");
  assert.ok(seen.cwdExistedAtStart);
  assert.ok(seen.opts.cwd.startsWith(os.tmpdir()));
  assert.ok(!fs.existsSync(seen.opts.cwd), "temp cwd must be removed");
  assert.deepEqual(fs.readdirSync(os.tmpdir()).filter((n) => seen.opts.cwd.endsWith(n)), []);
});

// ---- 6. served model selection ----
test("fix6: served model is the key matching the request, never just the first key", () => {
  assert.equal(pickServedModel({ "claude-haiku-5-5": {}, "claude-sonnet-5-5": {} }, "claude-sonnet-5-5").served, "claude-sonnet-5-5");
  assert.equal(pickServedModel({ "claude-haiku-5-5": {}, "claude-opus-5-5": {} }, "claude-sonnet-5-5").served, "unverified");
  assert.equal(pickServedModel({}, "claude-sonnet-5-5").served, "unverified");
  assert.equal(pickServedModel(undefined, "claude-sonnet-5-5").served, "unverified");
  const one = pickServedModel({ "claude-opus-5-5": {} }, "claude-sonnet-5-5");
  assert.equal(one.served, "claude-opus-5-5"); // a different single model is shown as served, with a note
  assert.match(one.note, /requested/);
});

test("fix6: unverified served model is listed in the report's Not verified", async () => {
  const m = createMockProvider();
  const provider = { ...m, name: "claude-cli", costsMoney: false, complete: async (q) => ({ ...(await m.complete(q)), provider: "claude-cli", servedModel: "unverified", servedNote: "the CLI reported no model usage", unmetered: true }) };
  const r = await run("fix typo", { provider, dryRun: false });
  assert.ok(r.unverified.some((u) => /served model could not be verified/.test(u)));
  assert.match(renderReport(r), /served unverified/);
});

// ---- 7. mock runs are never applied ----
test("fix7: apply refuses a mock run even with every gate approved", async () => {
  const target = tmp();
  const { runs, id } = finishedRun([{ path: "a.txt", action: "create", content: "x" }], { mock: true });
  await assert.rejects(applyRun({ runsDir: runs, runId: id, target, gates: createGates({ isTTY: false, approve: ["apply", "delete", "forcePartial"] }) }), /mock provider/);
  assert.deepEqual(fs.readdirSync(target), []);
});

// ---- 8. human gate ----
test("fix8: planner humanQuestions end BLOCKED unless the human gate is approved", async () => {
  const script = { plan: [{ summary: "s", spec: "sp", acceptanceCriteria: ["a"], risks: [], humanQuestions: ["Who may approve refunds?"] }] };
  const r = await run("design the database schema", { script });
  assert.equal(r.status, "BLOCKED");
  assert.equal(r.exitCode, 2);
  assert.equal(r.blockedAt, "PLANNING");
  assert.deepEqual(r.humanQuestions, ["Who may approve refunds?"]);
  assert.match(r.blockReason, /Who may approve refunds/);
  assert.match(renderReport(r), /OPEN QUESTIONS FOR A HUMAN[\s\S]*Who may approve refunds/);
  assert.ok(!kinds(r).includes("build"));
  const ok = await run("design the database schema", { script, approve: ["human"] });
  assert.equal(ok.status, "PASS");
  assert.ok(ok.unverified.some((u) => /proceeded without an answer to: Who may approve refunds/.test(u)));
  assert.equal(ok.approvals[0].kind, "human");
});

// ---- 9. cost / budget ----
test("fix9: every usage.iterations entry is priced by the model that ran it", () => {
  const c = stepCost(config, "claude-opus-5-5", { iterations: [
    { type: "message", model: "claude-fable-5-2", inputTokens: 1_000_000, outputTokens: 0, cacheRead: 0, cacheWrite: 0 },
    { type: "fallback_message", model: "claude-opus-5-5", inputTokens: 1_000_000, outputTokens: 0, cacheRead: 0, cacheWrite: 0 },
  ] });
  assert.ok(Math.abs(c.usd - 12) < 1e-9); // 8 + 4
  assert.equal(c.priceKnown, true);
  const u = stepCost(config, "claude-opus-5-5", { iterations: [{ model: "claude-mystery-9", inputTokens: 5 }, { model: "claude-opus-5-5", inputTokens: 1_000_000 }] });
  assert.equal(u.priceKnown, false);
  assert.deepEqual(u.unknownModels, ["claude-mystery-9"]);
});

test("fix9: anthropic provider keeps per-iteration usage from the response", async () => {
  const msg = { model: "claude-opus-4-8", stop_reason: "end_turn", content: [{ type: "text", text: "{}" }], usage: { input_tokens: 5, output_tokens: 5, iterations: [{ type: "message", model: "claude-fable-5-2", input_tokens: 3, output_tokens: 1 }, { type: "fallback_message", model: "claude-opus-4-8", input_tokens: 2, output_tokens: 4 }] } };
  const client = { messages: { stream: () => ({ finalMessage: async () => msg }) }, beta: { messages: { stream: () => ({ finalMessage: async () => msg }) } } };
  const r = await createAnthropicProvider({ client, config }).complete({ kind: "x", model: "claude-opus-5-5", effort: "low", maxTokens: 100, system: "s", messages: [{ role: "user", content: "x" }] });
  assert.deepEqual(r.usage.iterations.map((i) => i.model), ["claude-fable-5-2", "claude-opus-4-8"]);
  assert.equal(r.fallbackRan, true);
});

const paid = (served, extra = {}) => {
  const m = createMockProvider();
  return { name: "anthropic", costsMoney: true, capabilityCheck: m.capabilityCheck, complete: async (q) => ({ ...(await m.complete(q)), provider: "anthropic", servedModel: served, usage: { inputTokens: 10, outputTokens: 10, cacheRead: 0, cacheWrite: 0 }, ...extra }) };
};

test("fix9: budget is checked before every attempt (the retry is paid too)", async () => {
  const calls = [];
  const provider = {
    name: "anthropic", costsMoney: true, capabilityCheck: async () => ({ available: true, reason: "t" }),
    complete: async (q) => { calls.push(q); return { text: "garbage", provider: "anthropic", requestedModel: q.model, servedModel: "claude-sonnet-5-5", usage: { inputTokens: 0, outputTokens: 20000, cacheRead: 0, cacheWrite: 0 }, stopReason: "end_turn" }; },
  };
  const r = await run("fix typo", { provider, budgetUsd: 0.5, dryRun: false });
  assert.equal(calls.length, 1); // 20k out tokens = $0.20; remaining $0.30 < worst case of the retry
  assert.equal(r.status, "BLOCKED");
  assert.match(r.blockReason, /budget exhausted/);
  assert.ok(Math.abs(r.steps.at(-1).usd - 0.2) < 1e-9); // the first attempt's cost is on the blocked step
});

test("fix9: unknown price -> priceKnown:false in the report, BLOCKED when a budget is set", async () => {
  const free = await run("fix typo", { provider: paid("claude-mystery-9"), dryRun: false });
  assert.equal(free.status, "PASS");
  assert.match(renderReport(free), /priceKnown:false for claude-mystery-9/);
  const capped = await run("fix typo", { provider: paid("claude-mystery-9"), budgetUsd: 5, dryRun: false });
  assert.equal(capped.status, "BLOCKED");
  assert.match(capped.blockReason, /priceKnown:false/);
});

test("fix9: claude-cli cost is the reported cost (labelled) or 'subscription — not metered'", async () => {
  const reported = await run("fix typo", { provider: { ...paid("claude-sonnet-5-5", { provider: "claude-cli", reportedUsd: 0.0123 }), name: "claude-cli" }, dryRun: false });
  assert.ok(Math.abs(reported.cost.totalUsd - 0.0246) < 1e-9); // build + quick-check
  assert.match(renderReport(reported), /cost reported by claude CLI/);
  const un = await run("fix typo", { provider: { ...paid("claude-sonnet-5-5", { provider: "claude-cli", unmetered: true }), name: "claude-cli" }, dryRun: false });
  assert.equal(un.cost.totalUsd, 0);
  assert.match(renderReport(un), /subscription — not metered/);
});

// ---- 11. FAIL outside the audit states is recorded, not swallowed ----
test("fix11: FAIL while PLANNING reaches ESCALATED legally and is recorded", async () => {
  const r = await run("design the database schema", { script: { plan: ["not json at all"] } });
  assert.equal(r.status, "FAIL");
  assert.equal(r.state, "ESCALATED");
  assert.equal(r.exitCode, 1);
  const s = createState();
  s.to("CLASSIFIED");
  s.to("PLANNING");
  assert.doesNotThrow(() => s.to("ESCALATED"));
  assert.doesNotThrow(() => createState().to("ESCALATED"));
});

// ---- 12. fallbacks only for exact ids ----
test("fix12: server fallbacks only for the exact supported ids", async () => {
  for (const ok of ["claude-fable-5-2", "claude-opus-5-5", "claude-sonnet-5-5"]) assert.ok(supportsServerFallbacks(ok));
  for (const no of ["claude-opus-4-8", "claude-sonnet-5", "claude-fable-5-1", "claude-opus-5-5-20260101", "claude-haiku-5-5", "my-opus-proxy"]) assert.ok(!supportsServerFallbacks(no), no);
  const calls = [];
  const msg = { model: "claude-opus-4-8", stop_reason: "end_turn", content: [{ type: "text", text: "{}" }], usage: { input_tokens: 1, output_tokens: 1 } };
  const client = { messages: { stream: (b) => (calls.push(["messages", b]), { finalMessage: async () => msg }) }, beta: { messages: { stream: (b) => (calls.push(["beta", b]), { finalMessage: async () => msg }) } } };
  await createAnthropicProvider({ client, config }).complete({ kind: "x", model: "claude-opus-4-8", effort: "low", maxTokens: 100, system: "s", messages: [{ role: "user", content: "x" }] });
  assert.equal(calls[0][0], "messages");
  assert.equal(calls[0][1].fallbacks, undefined);
});

// ---- 13. L2 low-risk validator notice, planFlaw from correction builds ----
test("fix13: validator is told explicitly when no audit ran", async () => {
  const mock = createMockProvider();
  await run("build the features", { provider: mock });
  const v = mock.calls.find((c) => c.kind === "validation");
  assert.match(v.messages[0].content, /NO AUDIT RAN \(level 2, risk low\)/);
  const mock3 = createMockProvider();
  await run("design the database schema", { provider: mock3 });
  assert.match(mock3.calls.find((c) => c.kind === "validation").messages[0].content, /An independent audit ran/);
});

test("fix13: planFlaw reported by a correction-round build triggers a re-plan", async () => {
  const flawed = { summary: "s", planFlaw: true, planFlawReason: "spec contradicts audit", files: [], testsSuggested: [], limitations: [] };
  const ok = { summary: "s", planFlaw: false, planFlawReason: "", files: [{ path: "a.txt", action: "create", content: "x" }], testsSuggested: [], limitations: [] };
  const high = { verdict: "FAIL", summary: "bad", findings: [{ severity: "High", category: "correctness", file: "a.txt", description: "bug", fix: "fix" }] };
  const r = await run("design the database schema", { script: { build: [ok, flawed, ok], audit: [high, { verdict: "PASS", summary: "ok", findings: [] }] } });
  assert.equal(r.status, "PASS");
  assert.equal(r.replans, 1);
  assert.deepEqual(kinds(r), ["plan", "build", "audit", "build", "plan", "build", "audit", "validation"]);
});

// ---- 14. apply listing hygiene ----
test("fix14: control characters are escaped and executable-ish targets are flagged with a WARNING", async () => {
  assert.equal(printable("a\u001b[31mred\nb"), "a\\x1b[31mred\\x0ab");
  assert.match(executableWarning(".githooks/pre-commit") ?? "", /git/);
  assert.match(executableWarning(".husky/pre-push"), /husky/);
  assert.match(executableWarning(".vscode/tasks.json"), /tasks/);
  assert.match(executableWarning("package.json"), /scripts/);
  assert.match(executableWarning("tools/run.ps1"), /script/);
  assert.equal(executableWarning("src/app.js"), null);
  const target = tmp();
  const { runs, id } = finishedRun([{ path: "package.json", action: "create", content: "{}" }, { path: "ok.txt", action: "create", content: "x" }]);
  const lines = [];
  const seen = [];
  const gates = { request: async (k, d) => (seen.push(d), { kind: k, approved: true, mode: "t", who: "t", at: "t" }) };
  await applyRun({ runsDir: runs, runId: id, target, gates, log: (s) => lines.push(s) });
  assert.ok(lines.some((l) => /WARNING: package\.json is executable-ish/.test(l)));
  assert.match(seen[0], /WARNING executable-ish targets: package\.json/);
  const bad = hostile(["x\u001by.txt"]);
  await assert.rejects(applyRun({ runsDir: bad.runs, runId: bad.id, target, gates }), /control character/);
});

// ---- 15. cache multipliers from config ----
test("fix15: cache-read multiplier comes from config per model", () => {
  const read = (m) => stepCost(config, m, { cacheRead: 1_000_000 }).usd;
  assert.ok(Math.abs(read("claude-opus-5-5") - 0.2) < 1e-9); // 4 x 0.05
  assert.ok(Math.abs(read("claude-sonnet-5-5") - 0.1) < 1e-9); // 2 x 0.05
  assert.ok(Math.abs(read("claude-fable-5-2") - 0.2) < 1e-9); // 8 x 0.025
  assert.ok(Math.abs(read("claude-haiku-5-5") - 0.01) < 1e-9); // 0.1 x 0.1
  assert.equal(config.provider, "claude-cli"); // Owner decision: default provider
});

// ---- round 2: classifier stems, redaction gaps, apply mkdir order ----
test("round2: plural and inflected critical phrases are level 4 and gated", async () => {
  const critical = [
    "reset user passwords", "migrate the payments table and drop old columns", "encrypt stored card numbers", "add JWT sign-in with session cookies",
    "decrypt the backup files", "rotate API keys for the billing service", "add OAuth login with SSO", "enable 2FA and MFA", "store personal data for GDPR requests",
    "update RBAC permissions for roles", "deploy to production", "change the terraform infrastructure", "renew the TLS certificates", "truncate the sessions table",
    "delete from users where inactive", "charge a card on checkout", "add sign up with credentials",
  ];
  for (const t of critical) {
    const c = classify(t);
    assert.equal(c.level, 4, t);
    assert.equal(c.risk, "critical", t);
    assert.ok(route(c.level, { risk: c.risk, rulesLevel: c.rulesLevel }).includes("gate"), t);
  }
  const r = await run("reset user passwords");
  assert.equal(r.status, "BLOCKED");
  assert.equal(r.blockedAt, "APPROVAL_REQUIRED");
  for (const t of ["fix typo in README", "change button colour", "rename variable in greet.mjs"]) assert.equal(classify(t).level, 1, t);
  assert.equal(classify("fix typo by the author").level, 1); // "auth" stem must not match "author"
  assert.equal(classify("design tokens for the theme").level, 4); // strict on purpose: a false L4 only costs a gate
});

test("round2: classifier stems for level 3 and 2", () => {
  for (const t of ["design the databases", "split into multi-services", "add new modules", "review the schemas"]) assert.equal(classify(t).level, 3, t);
  for (const t of ["add endpoints for users", "build the features", "several files need an update"]) assert.equal(classify(t).level, 2, t);
});

test("round2: query secrets ?key= ?sig= ?code= and key-aware redactDeep", async () => {
  const { redactDeep } = await import("../src/redact.mjs");
  const u = redact("https://x.test/a?key=abcd1234&sig=zz9&code=c0de&access_token=t0k&ok=1");
  for (const leak of ["abcd1234", "zz9", "c0de", "t0k"]) assert.ok(!u.includes(leak), leak);
  assert.ok(u.includes("ok=1"));
  const o = redactDeep({ authorization: "Basic dXNlcjpw", apiKey: "abc123", password: "hunter2", cookie: "sid=1", session: "s1", inputTokens: 5, nested: { clientSecret: "s", name: "ok" }, list: [{ private_key: "k" }] });
  assert.equal(o.authorization, "[REDACTED]");
  assert.equal(o.apiKey, "[REDACTED]");
  assert.equal(o.password, "[REDACTED]");
  assert.equal(o.cookie, "[REDACTED]");
  assert.equal(o.session, "[REDACTED]");
  assert.equal(o.nested.clientSecret, "[REDACTED]");
  assert.equal(o.list[0].private_key, "[REDACTED]");
  assert.equal(o.inputTokens, 5); // numeric usage counters survive
  assert.equal(o.nested.name, "ok");
  console.log("--- redactDeep ---\n" + JSON.stringify(o) + "\n" + u);
});

test("round2: a link out of the target never gets directories created outside it", async (t) => {
  const target = tmp();
  const outside = tmp();
  try { fs.symlinkSync(outside, path.join(target, "link"), "junction"); } catch { return t.skip("junction not permitted"); }
  const { runs, id } = finishedRun([{ path: "link/new/sub/f.txt", action: "create", content: "x" }]);
  await assert.rejects(applyRun({ runsDir: runs, runId: id, target, gates: createGates({ isTTY: false, approve: ["apply"] }) }), /escapes target/);
  assert.deepEqual(fs.readdirSync(outside), []);
});

// ---- round 3: layered classifier, cookie header, trash junction ----
test("round3: the six sensitive phrases are level 4 (gated and audited); benign ones stay level 1", () => {
  for (const t of ["store user emails and phone numbers", "save customer home addresses and birthdates", "grant admin access to the dashboard", "add a privilege check to the admin panel", "hash user passcodes with bcrypt", "run the db upgrade script on live server", "store the SSN and national id", "keep customer data in the user data table"]) {
    const c = classify(t);
    assert.equal(c.level, 4, t);
    const r = route(c.level, { risk: c.risk, rulesLevel: c.rulesLevel });
    assert.ok(r.includes("audit") && r.includes("gate"), t);
  }
  for (const t of ["fix typo in README", "change button colour", "rename variable in greet.mjs", "update docs wording"]) assert.equal(classify(t).level, 1, t);
});

test("round3: a task matching no rule is risk medium and gets an audit", async () => {
  const c = classify("tidy the thing");
  assert.equal(c.level, 2);
  assert.equal(c.risk, "medium");
  assert.ok(route(c.level, { risk: c.risk }).includes("audit"));
  const r = await run("tidy the thing");
  assert.ok(kinds(r).includes("audit"));
});

const assistReply = (level, risk) => ({ classification: [{ level, risk, reasons: ["scripted"] }] });

test("round3: Haiku assist is stricter-wins, never lowers, and is logged with both answers", async () => {
  const dir = tmp();
  // rules say L1 low; assist says L3 high -> raised
  const up = await run("fix typo", { script: assistReply(3, "high"), assistClassify: true, runsDir: dir });
  assert.equal(up.classification.level, 3);
  assert.equal(up.classification.risk, "high");
  assert.ok(kinds(up).includes("classification"));
  assert.match(fs.readFileSync(path.join(dir, up.runId, "decisions.md"), "utf8"), /assist classification \(stricter wins, never lowers\): rules level 1 risk low; assist level 3 risk high; final level 3 risk high/);
  // rules say L4 critical; assist says L1 low -> unchanged
  const down = await run("reset user passwords", { script: assistReply(1, "low"), assistClassify: true });
  assert.equal(down.classification.level, 4);
  assert.equal(down.classification.risk, "critical");
  assert.equal(down.status, "BLOCKED"); // gate still required
  // assist risk raises level 1 so an audit can run
  const risk = await run("fix typo", { script: assistReply(1, "medium"), assistClassify: true });
  assert.equal(risk.classification.level, 2);
  assert.ok(kinds(risk).includes("audit"));
});

test("round3: assist failure keeps the rules result with the note and applies the safe default", async () => {
  const dir = tmp();
  const bad = await run("build the features", { script: { classification: ["not json"] }, assistClassify: true, runsDir: dir });
  assert.equal(bad.classification.level, 2);
  assert.equal(bad.classification.risk, "medium"); // low -> medium: audited
  assert.ok(bad.classification.reasons.some((r) => /assist unavailable/.test(r)));
  assert.ok(kinds(bad).includes("audit"));
  assert.match(fs.readFileSync(path.join(dir, bad.runId, "decisions.md"), "utf8"), /assist unavailable/);
  assert.ok(bad.steps.some((s) => s.kind === "classification" && s.status === "FAILED")); // honest record
  // provider that throws a ProviderError
  const m = createMockProvider();
  const { ProviderError } = await import("../src/providers/anthropic.mjs");
  const broken = { ...m, complete: async (q) => { if (q.kind === "classification") throw new ProviderError("failed", "boom"); return m.complete(q); } };
  const r = await run("fix typo", { provider: broken, assistClassify: true });
  assert.equal(r.status, "PASS");
  assert.equal(r.classification.level, 1); // pure text task stays L1
  assert.ok(r.classification.reasons.some((x) => /assist unavailable/.test(x)));
});

test("round3: assist defaults on for real providers, off for mock, and --no-assist-classify is logged", async () => {
  const m = createMockProvider();
  const real = { ...m, name: "claude-cli", costsMoney: false, complete: async (q) => ({ ...(await m.complete(q)), provider: "claude-cli", servedModel: q.model, unmetered: true }) };
  const on = await runPipeline({ task: "fix typo", provider: real, config, gates: createGates({ isTTY: false }), runsDir: tmp(), root: tmp() });
  assert.ok(kinds(on).includes("classification"));
  const dir = tmp();
  const off = await runPipeline({ task: "fix typo", provider: real, config, gates: createGates({ isTTY: false }), runsDir: dir, root: tmp(), assistClassify: false });
  assert.ok(!kinds(off).includes("classification"));
  assert.match(fs.readFileSync(path.join(dir, off.runId, "decisions.md"), "utf8"), /disabled \(--no-assist-classify\)/);
  const mockRun = await runPipeline({ task: "fix typo", provider: createMockProvider(), config, gates: createGates({ isTTY: false }), runsDir: tmp(), root: tmp() });
  assert.ok(!kinds(mockRun).includes("classification"));
});

test("round3: Cookie and Set-Cookie headers hide every value", () => {
  const c = redact("GET / HTTP/1.1\nCookie: sid=abc123; theme=dark\nSet-Cookie: auth=xyz789; Path=/; HttpOnly\nHost: x");
  for (const leak of ["abc123", "theme=dark", "xyz789"]) assert.ok(!c.includes(leak), leak);
  assert.ok(c.includes("Host: x"));
  assert.ok(!redact('{"cookie": "sid=q1w2e3"}').includes("q1w2e3"));
  console.log("--- cookie ---\n" + c);
});

test("round3: a pre-existing junction at .orchestrator-trash cannot carry deleted files out", async (t) => {
  const target = tmp();
  const outside = tmp();
  fs.writeFileSync(path.join(target, "gone.txt"), "keep me here");
  try { fs.symlinkSync(outside, path.join(target, ".orchestrator-trash"), "junction"); } catch { return t.skip("junction not permitted"); }
  const { runs, id } = finishedRun([{ path: "gone.txt", action: "delete", content: "" }]);
  const res = await applyRun({ runsDir: runs, runId: id, target, gates: createGates({ isTTY: false, approve: ["apply", "delete"] }) });
  assert.deepEqual(res.trashed, []);
  assert.match(res.skipped[0].reason, /trash folder escapes target/);
  assert.ok(fs.existsSync(path.join(target, "gone.txt")));
  assert.deepEqual(fs.readdirSync(outside), []);
});

test("round4: health, pay, money-movement and cloud-write tasks are level 4 and gated; benign stay level 1", () => {
  for (const t of ["export patient medical records to CSV", "let managers see other users' salaries", "refund the last 50 orders via Stripe", "give contractors write access to the S3 bucket",
    "show diagnoses and prescriptions in the portal", "run payroll and update wages", "set up a PayPal payout for sellers", "make the GCS bucket policy public"]) {
    const c = classify(t);
    assert.equal(c.level, 4, t);
    assert.ok(route(c.level, { risk: c.risk, rulesLevel: c.rulesLevel }).includes("gate"), t);
  }
  for (const t of ["fix typo in README", "change button colour", "update docs wording", "author bio text"]) assert.equal(classify(t).level, 1, t);
});
