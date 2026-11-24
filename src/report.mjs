/** Orchestrator dashboard (guide 5.13): machine form + text form. Reads only the run record. */

export function buildReport(run) {
  const models = run.steps.filter((s) => s.kind !== "local").map((s) => ({
    step: s.n, phase: s.phase, role: s.role, provider: s.provider, requestedModel: s.requestedModel,
    servedModel: s.servedModel ?? null, status: s.status, fallbackRan: !!s.fallbackRan,
    substitution: s.substitution ?? null, usd: s.usd ?? 0, priceKnown: s.priceKnown ?? null, unknownModels: s.unknownModels ?? [], costNote: s.costNote ?? null, note: s.note ?? null,
  }));
  const bySeverity = { Critical: [], High: [], Medium: [], Low: [], Informational: [] };
  for (const f of run.findings ?? []) (bySeverity[f.severity] ??= []).push(f);
  const gate = run.validation
    ? `${run.validation.verdict}${run.validation.basic ? " (basic verification only: not an independent audit)" : ""}`
    : "not reached";
  return {
    banner: run.mock ? "MOCK RUN — no model was called" : null,
    runId: run.runId,
    task: run.task,
    classification: run.classification,
    routing: models,
    plan: run.route,
    status: { status: run.status, state: run.state, blockedAt: run.blockedAt ?? null, reason: run.blockReason, exitCode: run.exitCode },
    findings: bySeverity,
    qualityGate: gate,
    nextAction: nextAction(run),
    cost: run.cost,
    notVerified: run.unverified,
    humanQuestions: run.humanQuestions ?? [],
    escalations: run.escalations,
    approvals: run.approvals,
  };
}

function nextAction(run) {
  switch (run.status) {
    case "PASS": return `Review runs/${run.runId}/proposals/round-${run.finalRound}, then: orchestrate apply ${run.runId} --target <dir>`;
    case "PARTIAL": return `Review the Not verified list; apply needs a forcePartial gate: orchestrate apply ${run.runId} --target <dir>`;
    case "BLOCKED": return `Resolve the block: ${run.blockReason}`;
    default: return `Human review needed: ${run.blockReason ?? "see findings"}`;
  }
}

export function renderReport(run) {
  const r = buildReport(run);
  const L = [];
  if (r.banner) L.push("!".repeat(60), r.banner, "!".repeat(60), "");
  L.push(`RUN ${r.runId}`, "", "TASK", `  ${r.task}`, "");
  const c = r.classification;
  L.push("CLASSIFICATION");
  if (c) {
    L.push(`  level ${c.level} | complexity ${c.complexity} | risk ${c.risk} | info ${c.info} | reasoning ${c.reasoning} | execution ${c.execution} | verification ${c.verification}`);
    for (const x of c.reasons) L.push(`  - ${x}`);
  } else L.push("  (not reached)");
  L.push("", "MODEL ROUTING (requested vs served)");
  if (!r.routing.length) L.push("  no model step ran");
  for (const s of r.routing) {
    const sub = s.substitution ? ` SUBSTITUTED ${s.substitution.from} -> ${s.substitution.to} (${s.substitution.reason})` : "";
    L.push(`  [${s.step}] ${s.phase} | ${s.role} | provider ${s.provider} | requested ${s.requestedModel} | served ${s.servedModel ?? "n/a"}${s.fallbackRan ? " | server fallback RAN" : ""}${sub} | ${s.status}${s.note ? ` (${s.note})` : ""} | ${(s.usd ?? 0).toFixed(4)}${s.priceKnown === false ? ` priceKnown:false (${s.unknownModels.join(", ")})` : ""}${s.costNote ? ` [${s.costNote}]` : ""}`);
  }
  L.push("", "EXECUTION PLAN", `  ${r.plan.length ? r.plan.join(" > ") : "(not reached)"}`);
  L.push("", "CURRENT STATUS", `  ${r.status.status}${r.status.blockedAt ? ` at ${r.status.blockedAt}` : ""} (state ${r.status.state}, exit ${r.status.exitCode})${r.status.reason ? `\n  reason: ${r.status.reason}` : ""}`);
  if (r.humanQuestions.length) L.push("", "OPEN QUESTIONS FOR A HUMAN", ...r.humanQuestions.map((q) => `  - ${q}`));
  L.push("", "FINDINGS");
  let any = false;
  for (const [sev, list] of Object.entries(r.findings)) for (const f of list) { any = true; L.push(`  [${sev}/${f.category}] ${f.file ? f.file + ": " : ""}${f.description}`); }
  if (!any) L.push("  none recorded");
  L.push("", "QUALITY GATE", `  ${r.qualityGate}`);
  if (r.approvals.length) for (const a of r.approvals) L.push(`  approval ${a.kind}: ${a.approved ? "granted" : "DENIED"} (${a.mode}, ${a.who}, ${a.at})`);
  L.push("", "NEXT ACTION", `  ${r.nextAction}`);
  L.push("", "COST", `  total $${(r.cost?.totalUsd ?? 0).toFixed(4)}${r.cost?.budgetUsd != null ? ` of budget $${r.cost.budgetUsd}` : ""}${run.mock ? " (mock: no spend)" : ""}`);
  for (const u of run.cost?.unpriced ?? []) L.push(`  step ${u.n}: priceKnown:false for ${u.models.join(", ")}${u.note ? ` (${u.note})` : ""}`);
  L.push("", "NOT VERIFIED", ...(r.notVerified.length ? r.notVerified.map((x) => `  - ${x}`) : ["  (nothing listed)"]));
  return L.join("\n");
}
