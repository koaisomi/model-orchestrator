/**
 * Deterministic scripted provider for tests and --dry-run. NEVER calls a model.
 * Every result says provider:"mock" and servedModel:"mock" (no model served).
 * `script` maps kind -> array of replies (object or fn(req)); the last entry repeats.
 */
const DEFAULTS = {
  plan: () => ({ summary: "mock plan", spec: "MOCK SPEC: apply the smallest change that meets the task.", acceptanceCriteria: ["change is minimal", "nothing else modified"], risks: [], humanQuestions: [] }),
  extraction: () => ({ facts: [], dependencies: [], conventions: [], unknowns: ["mock run: nothing was extracted by a model"] }),
  build: () => ({ summary: "MOCK proposal (no model was called)", planFlaw: false, planFlawReason: "", files: [{ path: "MOCK-PROPOSAL.md", action: "create", content: "# Mock proposal\n\nProduced by the mock provider. No model was called.\n" }], testsSuggested: [], limitations: ["mock output"] }),
  audit: () => ({ verdict: "PASS", summary: "mock audit: no findings (no model reviewed this)", findings: [] }),
  validation: () => ({ verdict: "PASS", reasons: ["mock validation (no model validated this)"], unverified: ["everything: mock run"] }),
  quickcheck: () => ({ ok: true, issues: [] }),
  classification: () => ({ level: 1, risk: "low", reasons: ["mock"] }),
};

/** @param {{script?:Record<string,(object|Function)[]>}} [o] */
export function createMockProvider({ script = {} } = {}) {
  const idx = {};
  const calls = [];
  return {
    name: "mock",
    costsMoney: false,
    calls,
    async capabilityCheck() { return { available: true, reason: "mock provider (no model is ever called)" }; },
    async complete(req) {
      calls.push(req);
      const q = script[req.kind];
      const i = (idx[req.kind] = (idx[req.kind] ?? -1) + 1);
      let reply = q?.length ? q[Math.min(i, q.length - 1)] : DEFAULTS[req.kind];
      if (typeof reply === "function") reply = reply(req, i);
      if (reply === undefined) throw new Error(`mock has no reply for kind ${req.kind}`);
      return {
        text: typeof reply === "string" ? reply : JSON.stringify(reply),
        provider: "mock",
        requestedModel: req.model,
        servedModel: "mock",
        usage: { inputTokens: 0, outputTokens: 0, cacheRead: 0, cacheWrite: 0 },
        stopReason: "end_turn",
        fallbackRan: false,
      };
    },
  };
}
