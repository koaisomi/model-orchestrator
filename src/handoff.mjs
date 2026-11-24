import { redactDeep } from "./redact.mjs";

export const HANDOFF_STATUS = ["READY", "BLOCKED", "NEEDS_CLARIFICATION"];
const REQUIRED = ["project", "task", "classification", "currentState", "nextAssignment", "handoffStatus"];

/**
 * Build the hand-off contract (guide Appendix A) as a JSON object.
 * @param {object} p
 */
export function buildHandoff(p) {
  const findings = { Critical: [], High: [], Medium: [], Low: [] };
  for (const f of p.findings ?? []) (findings[f.severity] ??= []).push(f);
  return {
    project: p.project,
    task: p.task,
    classification: p.classification,
    currentState: p.currentState,
    decisions: p.decisions ?? [],
    evidence: p.evidence ?? [],
    findings,
    nextAssignment: p.nextAssignment,
    approval: p.approval ?? { required: false, granted: null },
    handoffStatus: p.handoffStatus ?? "READY",
  };
}

/** @returns {{ok:boolean, missing:string[]}} */
export function validateHandoff(h) {
  const missing = REQUIRED.filter((k) => h?.[k] == null || h[k] === "");
  if (h?.nextAssignment && (!h.nextAssignment.role || !h.nextAssignment.instructions)) missing.push("nextAssignment.role/instructions");
  if (h?.handoffStatus && !HANDOFF_STATUS.includes(h.handoffStatus)) missing.push("handoffStatus(valid value)");
  if (h?.handoffStatus && h.handoffStatus !== "READY") missing.push(`handoffStatus is ${h.handoffStatus}`);
  return { ok: missing.length === 0, missing };
}

/** Markdown for the prompt. Always redacted. */
export function renderHandoff(h) {
  const r = redactDeep(h);
  const f = (arr) => (arr.length ? arr.map((x) => `  - [${x.severity}/${x.category ?? "-"}] ${x.file ? x.file + ": " : ""}${x.description}`).join("\n") : "  - none");
  return [
    "# HAND-OFF",
    `Project: ${r.project}`,
    `Task: ${r.task}`,
    `Classification: level ${r.classification.level} (${r.classification.complexity}), risk ${r.classification.risk}`,
    `Current state: ${r.currentState}`,
    "Decisions:", ...(r.decisions.length ? r.decisions.map((d) => `  - ${d}`) : ["  - none"]),
    "Evidence:", ...(r.evidence.length ? r.evidence.map((e) => `  - ${e}`) : ["  - none"]),
    "Findings:",
    ...["Critical", "High", "Medium", "Low"].map((s) => `- ${s}\n${f(r.findings[s] ?? [])}`),
    `Approval: required=${r.approval.required} granted=${r.approval.granted}`,
    `Next assignment (${r.nextAssignment.role}): ${r.nextAssignment.instructions}`,
    `Hand-off status: ${r.handoffStatus}`,
  ].join("\n");
}
