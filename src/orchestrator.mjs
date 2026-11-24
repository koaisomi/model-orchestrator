import fs from "node:fs";
import path from "node:path";
import { classify, mergeAssist } from "./classify.mjs";
import { route as routeFor } from "./router.mjs";
import { createState } from "./state.mjs";
import { buildHandoff, validateHandoff, renderHandoff } from "./handoff.mjs";
import { PROMPTS } from "./roles/prompts.mjs";
import { callStructured, StructuredOutputError, validateBuildPaths } from "./schemas.mjs";
import { retrieve, countContextFiles, RetrieveError } from "./retrieve.mjs";
import { redact } from "./redact.mjs";
import { createLedger, newRunId } from "./ledger.mjs";
import { stepCost, worstCase, createBudget } from "./cost.mjs";
import { roleSpec, priceOf } from "./models.mjs";
import { ProviderError } from "./providers/anthropic.mjs";

export const EXIT = { PASS: 0, FAIL: 1, BLOCKED: 2, PARTIAL: 3, USAGE: 4 };
export const exitCodeFor = (status) => EXIT[status] ?? 1;

const KIND_ROLE = { plan: "planner", extraction: "retriever", build: "builder", audit: "auditor", validation: "validator", quickcheck: "builder", classification: "retriever" };
const SYSTEM = { plan: "planner", extraction: "retriever", build: "builder", audit: "auditor", validation: "validator", quickcheck: "quickcheck", classification: "classifier" };
const BLOCKING = new Set(["Critical", "High"]);
const TERMINAL = new Set(["ESCALATED", "CLOSED", "BLOCKED", "CANCELLED"]);

class Stop extends Error {
  constructor(status, reason) { super(reason); this.status = status; }
}

/**
 * The pipeline engine. Never pretends a model ran: every step stores requested and served model + provider.
 * @param {object} o
 * @returns {Promise<object>} run record (also saved to runs/<id>/run.json)
 */
export async function runPipeline(o) {
  const { task, provider, config, gates, runsDir, root = process.cwd(), context = [], contextExplicit = true, levelOverride = null, dryRun = false, log = () => {} } = o;
  // layered classifier: rules, then a Haiku assist that is ON by default for real runs (mock runs script their own)
  const assistClassify = o.assistClassify ?? provider.name !== "mock";
  const maxRounds = o.maxRounds ?? config.limits.maxCorrectionRounds;
  const runId = newRunId();
  const ledger = createLedger(runsDir, runId);
  const st = createState((e) => ledger.event("transition", e));
  const budget = createBudget(o.budgetUsd ?? config.budgetUsd ?? null);
  const project = path.basename(path.resolve(root));
  const run = {
    runId, task: redact(task), createdAt: new Date().toISOString(), finishedAt: null,
    provider: provider.name, mock: provider.name === "mock", dryRun, root: path.resolve(root),
    state: "NEW", status: null, blockReason: null, classification: null, route: [],
    steps: [], findings: [], corrections: 0, replans: 0, finalRound: null, validation: null,
    approvals: [], escalations: [], humanQuestions: [], contextSkipped: [], cost: null, unverified: [], exitCode: null,
  };
  const decisions = [];
  let stepN = 0;
  let proposalSeq = 0;
  let plan = null, extraction = null, ctx = null, cls = null;
  const decide = (t) => { decisions.push(t); ledger.decision(t); };

  const recordStep = (s) => { run.steps.push(s); ledger.event("step", s); };

  /** One model call with hand-off, per-attempt budget check, structured output + one retry, and an honest step record. */
  async function callRole({ phase, kind, assignment, body, extraValidate, handoff = true }) {
    const role = KIND_ROLE[kind];
    const spec = roleSpec(config, role);
    const n = ++stepN;
    const base = { n, phase, role, kind, requestedModel: spec.model };
    const acc = { usd: 0, priceKnown: true, unknown: [], notes: new Set() };
    const costFields = () => ({ usd: acc.usd, priceKnown: acc.priceKnown, unknownModels: acc.unknown, costNote: [...acc.notes].join("; ") || null });
    let content = redact(body);
    if (handoff) {
      const h = buildHandoff({
        project, task: redact(task), classification: cls, currentState: st.current, decisions,
        evidence: run.steps.filter((s) => s.status === "OK").map((s) => `step ${s.n} ${s.phase} (${s.role}) OK`),
        findings: run.findings, nextAssignment: { role, instructions: assignment },
        approval: { required: cls?.level === 4, granted: run.approvals.at(-1)?.approved ?? null },
      });
      const v = validateHandoff(h);
      if (!v.ok) {
        recordStep({ ...base, provider: provider.name, status: "BLOCKED", note: `hand-off invalid: ${v.missing.join(", ")}` });
        throw new Stop("BLOCKED", `hand-off invalid for ${role}: ${v.missing.join(", ")}`);
      }
      ledger.saveHandoff(n, role, h);
      content = renderHandoff(h) + "\n\n" + content;
    }
    const system = PROMPTS[SYSTEM[kind]];

    // checked before EVERY paid attempt (retry, fallback model), not once per step
    const preflight = ({ model, system: sys, messages, maxTokens }) => {
      if (!provider.costsMoney) return;
      if (budget.limit != null && !priceOf(config, model)) throw new ProviderError("blocked", `budget: no price for ${model}, cannot enforce --budget-usd`);
      const chars = sys.length + messages.reduce((a, m) => a + m.content.length, 0);
      const w = worstCase(config, model, maxTokens, chars);
      if (budget.wouldExceed(w)) throw new ProviderError("blocked", `budget exhausted: worst case $${w.toFixed(4)} > remaining $${budget.remaining().toFixed(4)}`);
    };
    // booked right after every provider call, so a failed validation still shows what it cost
    const onResult = (result) => {
      let c;
      if (result.provider === "mock") c = { usd: 0, priceKnown: true, unknownModels: [], note: "mock: no spend" };
      else if (result.reportedUsd != null) c = { usd: result.reportedUsd, priceKnown: true, unknownModels: [], note: "cost reported by claude CLI" };
      else if (result.unmetered) c = { usd: 0, priceKnown: false, unknownModels: [result.servedModel], note: "subscription — not metered" };
      else c = stepCost(config, result.servedModel, result.usage);
      budget.add(c.usd);
      acc.usd += c.usd;
      acc.priceKnown = acc.priceKnown && c.priceKnown;
      for (const m of c.unknownModels) if (!acc.unknown.includes(m)) acc.unknown.push(m);
      if (c.note) acc.notes.add(c.note);
      if (!c.priceKnown && budget.limit != null) throw new ProviderError("blocked", `budget: price unknown for ${c.unknownModels.join(", ")} (priceKnown:false), cannot enforce --budget-usd`);
    };

    log(`  [${n}] ${phase} -> ${role} (${spec.model}) via ${provider.name}`);
    let out;
    try {
      out = await callStructured(provider, { kind, role, model: spec.model, effort: spec.effort, maxTokens: spec.maxTokens, fallbackModel: spec.fallbackModel, system, messages: [{ role: "user", content }], preflight, onResult }, extraValidate);
    } catch (e) {
      if (e instanceof ProviderError) {
        recordStep({ ...base, provider: provider.name, status: e.kind === "blocked" ? "BLOCKED" : "FAILED", note: e.message, ...costFields() });
        throw new Stop(e.kind === "blocked" ? "BLOCKED" : "FAIL", `${phase}: ${e.message}`);
      }
      if (e instanceof StructuredOutputError) {
        recordStep({ ...base, provider: provider.name, status: "FAILED", note: e.message, ...costFields() });
        throw new Stop("FAIL", `${phase}: ${e.message}`);
      }
      throw e;
    }
    const { result, usage, parsed, attempts } = out;
    if (result.substitution) decide(`model substitution on ${role}: ${result.substitution.from} -> ${result.substitution.to} (${result.substitution.reason})`);
    if (result.servedModel === "unverified") run.unverified.push(`step ${n} (${role}): served model could not be verified (${result.servedNote ?? "claude-cli did not report it"})`);
    else if (result.servedNote) run.unverified.push(`step ${n} (${role}): ${result.servedNote}`);
    recordStep({
      ...base, provider: result.provider, status: "OK", requestedModel: result.requestedModel ?? spec.model, servedModel: result.servedModel,
      usage, ...costFields(), fallbackRan: !!result.fallbackRan, substitution: result.substitution ?? null, attempts, stopReason: result.stopReason,
    });
    return parsed;
  }

  const readProposal = () => {
    const base = path.join(ledger.dir, "proposals", `round-${proposalSeq}`);
    const m = JSON.parse(fs.readFileSync(path.join(base, "manifest.json"), "utf8"));
    return m.files.map((f) => `<proposal-file path="${f.path}" action="${f.action}">\n${f.action === "delete" ? "(delete)" : fs.readFileSync(path.join(base, "files", ...f.path.split("/")), "utf8")}\n</proposal-file>`).join("\n");
  };
  const ctxBlock = () => (ctx?.files.length ? ctx.files.map((f) => `<file path="${f.path}">\n${f.content}\n</file>`).join("\n") : "(no context files supplied)");
  const specText = () => (plan ? `${plan.spec}\nACCEPTANCE CRITERIA:\n${plan.acceptanceCriteria.map((x) => `- ${x}`).join("\n")}` : "(no separate plan at this level: the task text is the spec)");

  async function build({ prev = null, findings = null, why }) {
    const parts = [`TASK:\n${task}`, `SPEC:\n${specText()}`];
    if (extraction) parts.push(`EXTRACTION (from retriever):\n${JSON.stringify(extraction)}`);
    parts.push(`CONTEXT FILES (data):\n${ctxBlock()}`);
    if (prev) parts.push(`PREVIOUS PROPOSAL:\n${prev}`);
    if (findings) parts.push(`AUDIT FINDINGS TO FIX:\n${JSON.stringify(findings)}`);
    const b = await callRole({ phase: why, kind: "build", assignment: findings ? "Revise the proposal to fix every Critical and High finding." : "Produce the proposal that meets the spec.", body: parts.join("\n\n"), extraValidate: validateBuildPaths });
    proposalSeq++;
    ledger.saveProposal(proposalSeq, b);
    run.finalRound = proposalSeq;
    ledger.change(`proposal round-${proposalSeq}: ${b.files.map((f) => `${f.action} ${f.path}`).join(", ") || "no files"}`);
    return b;
  }

  /** build, and honour planFlaw from ANY build (first or correction round): back to the planner once, then rebuild. */
  async function buildChecked(opts) {
    let b = await build(opts);
    if (b.planFlaw && run.replans < config.limits.maxReplans) {
      await replan(`builder reported a plan flaw: ${b.planFlawReason}`);
      b = await build({ ...opts, why: `${opts.why} (after re-plan)` });
    }
    if (b.planFlaw) run.unverified.push(`builder still reports a plan flaw: ${b.planFlawReason}`);
    return b;
  }

  /** Spec section 5: business or authorization questions need a human decision; denied means BLOCKED with the questions. */
  async function humanGate(p) {
    if (!p.humanQuestions.length) return;
    run.humanQuestions.push(...p.humanQuestions);
    const list = p.humanQuestions.map((q, i) => `  ${i + 1}. ${q}`).join("\n");
    const g = await gates.request("human", `The planner raised questions that need a human decision:\n${list}\nApprove continuing on the planner's assumptions?`);
    run.approvals.push(g);
    ledger.event("gate", g);
    decide(`gate human: ${g.approved ? "approved" : "denied"} (${g.mode}) by ${g.who}; ${p.humanQuestions.length} question(s)`);
    if (!g.approved) throw new Stop("BLOCKED", `human decision required (gate ${g.mode}). Open questions:\n${list}`);
    run.unverified.push(...p.humanQuestions.map((q) => `proceeded without an answer to: ${q}`));
  }

  async function replan(reason) {
    st.to("ESCALATED", reason);
    run.escalations.push({ to: "planner", reason });
    ledger.event("escalation", { to: "planner", reason });
    decide(`escalation to planner: ${reason}`);
    st.to("PLANNING", "re-plan");
    plan = await callRole({ phase: "re-plan", kind: "plan", assignment: "Re-plan: previous plan was reported as flawed.", body: `TASK:\n${task}\n\nPREVIOUS PLAN:\n${plan ? specText() : "(none)"}\n\nREASON FOR RE-PLAN:\n${reason}` });
    run.replans++;
    await humanGate(plan);
    st.to("READY_FOR_BUILD");
    st.to("EXECUTING");
  }

  try {
    const cap = await provider.capabilityCheck();
    if (!cap.available) throw new Stop("BLOCKED", `provider "${provider.name}" not available: ${cap.reason}. No model was called.`);

    // classify
    const count = contextExplicit && context.length ? countContextFiles(context, root) : 0;
    cls = classify(task, { contextFileCount: count, levelOverride });
    if (o.assistClassify === false) decide("assist classification disabled (--no-assist-classify): rules only");
    if (assistClassify) {
      const rules = cls;
      let a = null;
      try {
        a = await callRole({ phase: "assist-classify", kind: "classification", handoff: false, assignment: "", body: `Classify this task:\n${task}` });
      } catch (e) {
        if (!(e instanceof Stop)) throw e;
        // keep the rules result; safe default: a level-2 task still gets an audit
        cls = { ...cls, reasons: [...cls.reasons, `assist unavailable (${e.message}); rules result kept`] };
        if (cls.level === 2 && cls.risk === "low") { cls.risk = "medium"; cls.reasons.push("assist unavailable: risk raised to medium so an audit runs"); }
        decide(`assist unavailable: ${e.message}; rules said level ${rules.level} risk ${rules.risk}; final level ${cls.level} risk ${cls.risk}`);
      }
      if (a) {
        cls = mergeAssist(cls, a);
        decide(`assist classification (stricter wins, never lowers): rules level ${rules.level} risk ${rules.risk}; assist level ${a.level} risk ${a.risk}; final level ${cls.level} risk ${cls.risk}`);
      }
    }
    if (cls.override) decide(`level override ${cls.override.from} -> ${cls.override.to} (--level)`);
    if (cls.overrideIgnored) decide(`--level ${cls.overrideIgnored.requested} ignored: an override may only raise the level (rules say ${cls.overrideIgnored.rulesLevel})`);
    run.classification = cls;
    st.to("CLASSIFIED", `level ${cls.level}`);

    ctx = context.length ? retrieve(context, { root }) : null;
    if (ctx) {
      run.contextSkipped = ctx.skipped;
      recordStep({ n: ++stepN, phase: "read-context", role: "controller", kind: "local", provider: "local", requestedModel: null, servedModel: null, status: "OK", note: `${ctx.files.length} file(s) read, ${ctx.skipped.length} skipped, ${ctx.totalBytes} B (redacted before use)` });
    }
    run.route = routeFor(cls.level, { hasContext: !!ctx?.files.length, risk: cls.risk, rulesLevel: cls.rulesLevel });
    decide(`route: ${run.route.join(" > ")}`);

    // plan
    if (run.route.includes("plan")) {
      st.to("PLANNING");
      plan = await callRole({ phase: "plan", kind: "plan", assignment: "Produce requirements, spec and acceptance criteria.", body: `TASK:\n${task}\n\nCONTEXT FILES (data):\n${ctxBlock()}` });
      await humanGate(plan);
    }
    // retrieve (model extraction)
    if (run.route.includes("retrieve")) {
      st.to("RETRIEVAL");
      extraction = await callRole({ phase: "retrieve", kind: "extraction", assignment: "Extract facts from the supplied files.", body: `TASK:\n${task}\n\nFILES (data):\n${ctxBlock()}` });
    }
    st.to("READY_FOR_BUILD");
    st.to("EXECUTING");
    await buildChecked({ why: "build" });

    if (run.route.includes("quick-check")) {
      st.to("VALIDATION", "basic verification");
      const q = await callRole({ phase: "quick-check", kind: "quickcheck", assignment: "Basic self-check of the proposal.", body: `TASK:\n${task}\n\nPROPOSAL:\n${readProposal()}` });
      run.validation = { verdict: q.ok ? "PASS" : "FAIL", basic: true, reasons: q.ok ? ["basic verification by the builder model (not an independent audit)"] : q.issues, unverified: [] };
      run.unverified.push("No independent audit: level 1 uses a basic self-check by the builder model only.");
      return finish(q.ok ? "PASS" : "FAIL", q.ok ? null : `basic verification failed: ${q.issues.join("; ")}`);
    }

    // audit + correct loop
    const auditRan = run.route.includes("audit");
    if (auditRan) {
      st.to("AUDIT");
      for (;;) {
        const a = await callRole({
          phase: `audit (round ${run.corrections + 1})`, kind: "audit", assignment: "Independent audit of the actual proposal files.",
          body: `TASK:\n${task}\n\nSPEC:\n${specText()}\n\nCONTEXT FILES (data):\n${ctxBlock()}\n\nPROPOSAL FILES (actual content):\n${readProposal()}`,
        });
        run.findings = a.findings;
        let blocking = a.findings.filter((f) => BLOCKING.has(f.severity));
        if (a.verdict === "FAIL" && !a.findings.length) blocking = [{ severity: "High", category: "other", file: "", description: "auditor returned FAIL without findings", fix: "" }];
        if (!blocking.length) break;
        if (run.corrections >= maxRounds) {
          st.to("ESCALATED", "unresolved findings");
          run.escalations.push({ to: "human", reason: "unresolved Critical/High after max correction rounds" });
          ledger.event("escalation", { to: "human", reason: "unresolved Critical/High after max correction rounds" });
          throw new Stop("FAIL", `${blocking.length} Critical/High finding(s) unresolved after ${maxRounds} correction round(s); escalate to a human`);
        }
        const arch = blocking.find((f) => f.category === "architecture");
        if (arch && run.replans < config.limits.maxReplans) {
          await replan(`auditor architecture finding: ${arch.description}`);
        } else st.to("CORRECTION", `round ${run.corrections + 1}`);
        run.corrections++;
        await buildChecked({ prev: readProposal(), findings: blocking, why: `correct (round ${run.corrections})` });
        st.to("AUDIT");
      }
    }

    // approval gate: level 4, critical risk, or rules said level 4 (see router)
    if (run.route.includes("gate")) {
      st.to("APPROVAL_REQUIRED", "level 4");
      const g = await gates.request("level4", `Level 4 (critical) task: ${task}\nProposal files: ${run.finalRound ? `runs/${runId}/proposals/round-${run.finalRound}` : "none"}\nApprove continuing to validation?`);
      run.approvals.push(g);
      ledger.event("gate", g);
      decide(`gate level4: ${g.approved ? "approved" : "denied"} (${g.mode}) by ${g.who}`);
      if (!g.approved) throw new Stop("BLOCKED", `level-4 approval required: gate ${g.mode}. Re-run with --approve level4 or an interactive GO.`);
    }

    // validate
    st.to("VALIDATION");
    const auditNote = auditRan ? "An independent audit ran; findings above." : `NO AUDIT RAN (level ${cls.level}, risk ${cls.risk}): the proposal was never independently reviewed. Say so in unverified.`;
    const v = await callRole({
      phase: "validate", kind: "validation", assignment: "Final validation against the spec and acceptance criteria.",
      body: `TASK:\n${task}\n\nSPEC:\n${specText()}\n\nAUDIT STATUS:\n${auditNote}\n\nAUDIT FINDINGS (final):\n${JSON.stringify(run.findings)}\n\nOPEN ITEMS:\n${JSON.stringify(run.unverified)}\n\nPROPOSAL FILES (actual content):\n${readProposal()}`,
    });
    run.validation = v;
    run.unverified.push(...v.unverified.map((u) => `validator: ${u}`));
    if (v.verdict === "BLOCKED") throw new Stop("BLOCKED", `validator BLOCKED: ${v.reasons.join("; ")}`);
    if (v.verdict === "FAIL") { st.to("ESCALATED", "validation FAIL"); throw new Stop("FAIL", `validator FAIL: ${v.reasons.join("; ")}`); }
    return finish(v.verdict);
  } catch (e) {
    if (e instanceof Stop) return finish(e.status, e.message);
    if (e instanceof RetrieveError) return finish("BLOCKED", `context refused: ${e.message}`);
    run.status = "FAIL";
    run.blockReason = `internal error: ${e.message}`;
    ledger.event("error", { message: e.message });
    return finish("FAIL", run.blockReason);
  }

  function finish(status, reason = null) {
    run.status = status;
    run.blockReason = reason;
    if (status === "PASS" || status === "PARTIAL") { st.to("COMPLETE"); st.to("CLOSED"); }
    else if (status === "BLOCKED") { run.blockedAt = st.current; if (st.current !== "BLOCKED") st.to("BLOCKED", reason ?? ""); }
    else if (!TERMINAL.has(st.current)) st.to("ESCALATED", reason ?? "");
    else ledger.event("state-note", { note: `status ${status} recorded while already in ${st.current}` });
    run.state = st.current;
    run.finishedAt = new Date().toISOString();
    const priced = run.steps.filter((s) => s.usd != null);
    run.cost = { totalUsd: budget.spent, budgetUsd: budget.limit, byStep: priced.map((s) => ({ n: s.n, usd: s.usd })), unpriced: priced.filter((s) => s.priceKnown === false).map((s) => ({ n: s.n, models: s.unknownModels, note: s.costNote })) };
    if (run.mock) run.unverified.unshift("MOCK RUN: no model was called; every model output above is scripted.");
    if (!ctx?.files.length) run.unverified.push("No context files were supplied: models worked from the task text only.");
    if (run.contextSkipped.length) run.unverified.push(`${run.contextSkipped.length} context path(s) skipped: ${run.contextSkipped.map((s) => `${s.path} (${s.reason})`).join("; ")}`);
    run.unverified.push("Proposed code was not executed or tested by the controller (no shell execution of model output).");
    if (run.route.length && !run.route.includes("audit") && !run.route.includes("quick-check")) run.unverified.push("No audit ran (risk low at level 2).");
    run.exitCode = exitCodeFor(status);
    ledger.event("end", { status, reason, state: run.state });
    ledger.saveRun(run);
    return run;
  }
}
