import { safeJoin } from "./paths.mjs";

const S = { type: "string" };
const SA = { type: "array", items: S };
const obj = (properties, required = Object.keys(properties)) => ({ type: "object", properties, required, additionalProperties: false });

export const SEVERITIES = ["Critical", "High", "Medium", "Low", "Informational"];
export const CATEGORIES = ["correctness", "security", "architecture", "tests", "style", "business", "other"];

export const SCHEMAS = {
  plan: obj({ summary: S, spec: S, acceptanceCriteria: SA, risks: SA, humanQuestions: SA }),
  extraction: obj({
    facts: { type: "array", items: obj({ fact: S, file: S }) },
    dependencies: SA, conventions: SA, unknowns: SA,
  }),
  build: obj({
    summary: S,
    planFlaw: { type: "boolean" },
    planFlawReason: S,
    files: { type: "array", items: obj({ path: S, action: { type: "string", enum: ["create", "replace", "delete"] }, content: S }) },
    testsSuggested: SA, limitations: SA,
  }),
  audit: obj({
    verdict: { type: "string", enum: ["PASS", "FAIL"] },
    summary: S,
    findings: {
      type: "array",
      items: obj({ severity: { type: "string", enum: SEVERITIES }, category: { type: "string", enum: CATEGORIES }, file: S, description: S, fix: S }),
    },
  }),
  validation: obj({
    verdict: { type: "string", enum: ["PASS", "FAIL", "BLOCKED", "PARTIAL"] },
    reasons: SA, unverified: SA,
  }),
  quickcheck: obj({ ok: { type: "boolean" }, issues: SA }),
  classification: obj({
    level: { type: "integer", enum: [1, 2, 3, 4] },
    risk: { type: "string", enum: ["low", "medium", "high", "critical"] },
    reasons: SA,
  }),
};

/** Minimal JSON-schema checker: type, enum, required, properties, items, additionalProperties:false. Returns error strings. */
export function validate(schema, v, at = "$") {
  const errs = [];
  const t = schema.type;
  const actual = Array.isArray(v) ? "array" : v === null ? "null" : typeof v;
  if (t === "integer" ? !Number.isInteger(v) : t === "number" ? typeof v !== "number" : actual !== t) {
    return [`${at}: expected ${t}, got ${actual}`];
  }
  if (schema.enum && !schema.enum.includes(v)) errs.push(`${at}: ${JSON.stringify(v)} not in [${schema.enum.join(", ")}]`);
  if (t === "object") {
    for (const k of schema.required ?? []) if (!(k in v)) errs.push(`${at}.${k}: required`);
    for (const [k, sub] of Object.entries(schema.properties ?? {})) if (k in v) errs.push(...validate(sub, v[k], `${at}.${k}`));
    if (schema.additionalProperties === false) for (const k of Object.keys(v)) if (!(k in schema.properties)) errs.push(`${at}.${k}: unexpected key`);
  }
  if (t === "array") v.forEach((x, i) => errs.push(...validate(schema.items, x, `${at}[${i}]`)));
  return errs;
}

/** Extra check for builder output: every path must be safe to join under a proposal dir. */
export function validateBuildPaths(b) {
  const errs = [];
  const seen = new Set();
  for (const f of b.files ?? []) {
    try { safeJoin("/proposal-root", f.path); } catch (e) { errs.push(`files: ${e.message}`); }
    const k = String(f.path).toLowerCase();
    if (seen.has(k)) errs.push(`files: duplicate path ${f.path}`);
    seen.add(k);
  }
  return errs;
}

const sumUsage = (a, b) => ({
  inputTokens: (a.inputTokens ?? 0) + (b.inputTokens ?? 0),
  outputTokens: (a.outputTokens ?? 0) + (b.outputTokens ?? 0),
  cacheRead: (a.cacheRead ?? 0) + (b.cacheRead ?? 0),
  cacheWrite: (a.cacheWrite ?? 0) + (b.cacheWrite ?? 0),
  ...((a.iterations || b.iterations) ? { iterations: [...(a.iterations ?? []), ...(b.iterations ?? [])] } : {}),
});

export class StructuredOutputError extends Error {}

/**
 * Call a provider expecting JSON that matches SCHEMAS[req.kind]. One retry with the validation
 * error appended; second failure throws StructuredOutputError (the step FAILS).
 * @returns {Promise<{parsed:any, result:object, usage:object, attempts:number}>} result = last provider result
 */
export async function callStructured(provider, req, extraValidate) {
  const schema = SCHEMAS[req.kind];
  if (!schema) throw new Error(`no schema for kind ${req.kind}`);
  let messages = req.messages;
  let usage = {};
  let lastErr = "";
  for (let attempt = 1; attempt <= 2; attempt++) {
    // budget is checked before EVERY attempt (the retry is a second paid call), usage is booked right after each one
    req.preflight?.({ model: req.model, system: req.system, messages, maxTokens: req.maxTokens });
    const result = await provider.complete({ ...req, messages, schema });
    req.onResult?.(result);
    usage = sumUsage(usage, result.usage ?? {});
    let parsed, errs;
    try {
      parsed = JSON.parse(result.text);
      errs = validate(schema, parsed);
      if (!errs.length && extraValidate) errs = extraValidate(parsed);
    } catch (e) { errs = [`not valid JSON: ${e.message}`]; }
    if (!errs.length) return { parsed, result, usage, attempts: attempt };
    lastErr = errs.slice(0, 8).join("; ");
    messages = [
      ...req.messages,
      { role: "assistant", content: result.text || "(empty)" },
      { role: "user", content: `Your previous reply failed validation: ${lastErr}. Reply again with ONLY the corrected JSON object.` },
    ];
  }
  throw new StructuredOutputError(`${req.kind}: invalid structured output after one retry: ${lastErr}`);
}
