import { test } from "node:test";
import assert from "node:assert/strict";
import { classify, mergeAssist } from "../src/classify.mjs";
import { route } from "../src/router.mjs";
import { createState, canMove, IllegalTransition } from "../src/state.mjs";
import { buildHandoff, validateHandoff, renderHandoff } from "../src/handoff.mjs";
import { stepCost, worstCase, createBudget } from "../src/cost.mjs";
import { validateConfig, loadConfig, ConfigError } from "../src/config.mjs";
import { createGates } from "../src/gates.mjs";
import { SCHEMAS, validate, callStructured, StructuredOutputError } from "../src/schemas.mjs";

const cfg = loadConfig({ env: {} });

test("classifier: levels from keywords, highest wins", () => {
  assert.equal(classify("fix typo in README").level, 1);
  assert.equal(classify("add endpoint for users").level, 2);
  assert.equal(classify("design the database schema").level, 3);
  assert.equal(classify("add login with password reset").level, 4);
  assert.equal(classify("fix typo in the login page").level, 4);
  assert.equal(classify("do the thing").level, 2); // default
  assert.equal(classify("typo", { contextFileCount: 6 }).level, 3);
  assert.equal(classify("typo", { contextFileCount: 3 }).level, 2);
});

test("classifier: word-bounded (author is not auth, roller is not role)", () => {
  assert.equal(classify("fix typo by the author").level, 1);
  assert.equal(classify("fix typo in roller.js").level, 1);
});

test("classifier: --level override is logged; invalid rejected", () => {
  const c = classify("fix typo", { levelOverride: 3 });
  assert.equal(c.level, 3);
  assert.deepEqual(c.override, { from: 1, to: 3 });
  assert.ok(c.reasons.some((r) => r.includes("override")));
  assert.throws(() => classify("x", { levelOverride: 9 }));
});

test("classifier: model assist can raise but never lower", () => {
  const rules = classify("add login");
  assert.equal(mergeAssist(rules, { level: 1, risk: "low", reasons: [] }).level, 4);
  assert.equal(mergeAssist(rules, { level: 1, risk: "low", reasons: [] }).risk, "critical");
  const low = classify("fix typo");
  const m = mergeAssist(low, { level: 3, risk: "high", reasons: [] });
  assert.equal(m.level, 3);
  assert.equal(m.risk, "high");
});

test("router: phases per level", () => {
  assert.deepEqual(route(1), ["build", "quick-check"]);
  assert.deepEqual(route(1, { hasContext: true }), ["build", "quick-check"]);
  assert.deepEqual(route(2, { risk: "low" }), ["build", "validate"]);
  assert.deepEqual(route(2, { risk: "medium", hasContext: true }), ["retrieve", "build", "audit", "validate"]);
  assert.deepEqual(route(3, { hasContext: true }), ["plan", "retrieve", "build", "audit", "validate"]);
  assert.deepEqual(route(3), ["plan", "build", "audit", "validate"]);
  assert.deepEqual(route(4, { hasContext: true }), ["plan", "retrieve", "build", "audit", "gate", "validate"]);
});

test("state machine: legal path, illegal throws, events emitted", () => {
  const ev = [];
  const s = createState((e) => ev.push(e));
  for (const n of ["CLASSIFIED", "PLANNING", "RETRIEVAL", "READY_FOR_BUILD", "EXECUTING", "AUDIT", "CORRECTION", "AUDIT", "APPROVAL_REQUIRED", "VALIDATION", "COMPLETE", "CLOSED"]) s.to(n);
  assert.equal(s.current, "CLOSED");
  assert.equal(ev.length, 12);
  assert.throws(() => createState().to("EXECUTING"), IllegalTransition);
  assert.throws(() => s.to("PLANNING"), IllegalTransition); // terminal
  assert.throws(() => createState().to("NOPE"), IllegalTransition);
});

test("state machine: any state -> BLOCKED/CANCELLED, BLOCKED terminal, ESCALATED -> PLANNING", () => {
  for (const from of ["NEW", "AUDIT", "VALIDATION", "ESCALATED"]) {
    assert.ok(canMove(from, "BLOCKED"));
    assert.ok(canMove(from, "CANCELLED"));
  }
  assert.ok(!canMove("BLOCKED", "PLANNING"));
  assert.ok(canMove("ESCALATED", "PLANNING"));
  assert.ok(!canMove("NEW", "AUDIT"));
});

test("hand-off: valid, then missing fields -> not ok", () => {
  const h = buildHandoff({ project: "p", task: "t", classification: classify("typo"), currentState: "NEW", nextAssignment: { role: "builder", instructions: "do" } });
  assert.deepEqual(validateHandoff(h), { ok: true, missing: [] });
  assert.match(renderHandoff(h), /Next assignment \(builder\)/);
  const bad = { ...h, nextAssignment: null, task: "" };
  const v = validateHandoff(bad);
  assert.equal(v.ok, false);
  assert.ok(v.missing.includes("task") && v.missing.includes("nextAssignment"));
  assert.equal(validateHandoff({ ...h, handoffStatus: "BLOCKED" }).ok, false);
});

test("hand-off: secrets redacted when rendered", () => {
  const h = buildHandoff({ project: "p", task: "use Authorization: Bearer abc123xyz", classification: classify("typo"), currentState: "NEW", nextAssignment: { role: "builder", instructions: "x" } });
  assert.ok(!renderHandoff(h).includes("abc123xyz"));
});

test("cost math at served-model price; cache tokens; unknown model is 0 and flagged", () => {
  const c = stepCost(cfg, "claude-opus-5-5", { inputTokens: 1_000_000, outputTokens: 500_000, cacheRead: 1_000_000, cacheWrite: 1_000_000 });
  // 4 + 10 + 0.05*4 + 1.25*4 = 19.2 (cache multipliers come from config per model)
  assert.ok(Math.abs(c.usd - 19.2) < 1e-9);
  assert.deepEqual(stepCost(cfg, "mock", { inputTokens: 5 }), { usd: 0, priceKnown: false, unknownModels: ["mock"] });
  assert.ok(Math.abs(worstCase(cfg, "claude-sonnet-5-5", 32000, 3000) - (1000 * 2 + 32000 * 10) / 1e6) < 1e-12);
  const b = createBudget(1);
  b.add(0.9);
  assert.ok(b.wouldExceed(0.2));
  assert.ok(!b.wouldExceed(0.05));
  assert.ok(!createBudget(null).wouldExceed(1e9));
});

test("config: independence rule + date suffix + missing price rejected", () => {
  const c = structuredClone(cfg);
  c.roles.auditor.model = c.roles.builder.model;
  assert.throws(() => validateConfig(c), /independence/);
  c.allowSameModelAudit = true;
  assert.doesNotThrow(() => validateConfig(c));
  const d = structuredClone(cfg);
  d.roles.builder.model = "claude-sonnet-5-5-20260101";
  assert.throws(() => validateConfig(d), ConfigError);
});

test("gates: non-TTY denies, pre-approve grants and is logged, interactive needs GO", async () => {
  const g1 = createGates({ isTTY: false });
  assert.equal((await g1.request("level4", "x")).approved, false);
  assert.equal(g1.decisions[0].mode, "denied-non-tty");
  const g2 = createGates({ isTTY: false, approve: ["level4"] });
  const d = await g2.request("level4", "x");
  assert.equal(d.approved, true);
  assert.equal(d.mode, "pre-approved");
  assert.equal(d.who, "cli-user");
  assert.ok(d.at);
  assert.equal((await g2.request("apply", "x")).approved, false); // only level4 pre-approved
  assert.equal((await createGates({ isTTY: true, ask: async () => "GO" }).request("apply", "x")).approved, true);
  assert.equal((await createGates({ isTTY: true, ask: async () => "yes" }).request("apply", "x")).approved, false);
  assert.throws(() => createGates({ approve: ["bogus"] }));
});

test("schema validator: types, enums, required, extra keys", () => {
  assert.deepEqual(validate(SCHEMAS.quickcheck, { ok: true, issues: [] }), []);
  assert.ok(validate(SCHEMAS.quickcheck, { ok: "yes", issues: [] }).length);
  assert.ok(validate(SCHEMAS.quickcheck, { ok: true }).some((e) => e.includes("issues")));
  assert.ok(validate(SCHEMAS.quickcheck, { ok: true, issues: [], extra: 1 }).some((e) => e.includes("unexpected")));
  assert.ok(validate(SCHEMAS.validation, { verdict: "MAYBE", reasons: [], unverified: [] }).length);
});

test("callStructured: one retry with the validation error appended, then success", async () => {
  const seen = [];
  const provider = {
    async complete(req) {
      seen.push(req.messages);
      return { text: seen.length === 1 ? '{"ok":"nope"}' : '{"ok":true,"issues":[]}', usage: { inputTokens: 10, outputTokens: 5 } };
    },
  };
  const r = await callStructured(provider, { kind: "quickcheck", messages: [{ role: "user", content: "q" }] });
  assert.equal(r.attempts, 2);
  assert.deepEqual(r.parsed, { ok: true, issues: [] });
  assert.equal(r.usage.inputTokens, 20);
  assert.equal(seen[1].length, 3);
  assert.match(seen[1][2].content, /failed validation/);
  assert.equal(seen[1][2].role, "user");
});

test("callStructured: second failure throws StructuredOutputError (no third call)", async () => {
  let n = 0;
  const provider = { async complete() { n++; return { text: "not json", usage: {} }; } };
  await assert.rejects(callStructured(provider, { kind: "quickcheck", messages: [] }), StructuredOutputError);
  assert.equal(n, 2);
});
