import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const ROLES = ["planner", "retriever", "builder", "auditor", "validator"];
export const PROVIDER_NAMES = ["anthropic", "claude-cli", "mock"];

export class ConfigError extends Error {}

/**
 * @typedef {{model:string, effort:string, maxTokens:number, fallbackModel?:string}} RoleSpec
 * @typedef {{provider:string, serverFallbacks:boolean, allowSameModelAudit:boolean, budgetUsd:number|null,
 *   limits:{maxCorrectionRounds:number, maxReplans:number}, roles:Record<string,RoleSpec>,
 *   prices:Record<string,{in:number,out:number}>, gates:string[]}} Config
 */

/** Pure validation. Throws ConfigError listing every problem. */
export function validateConfig(c) {
  const errs = [];
  if (!c || typeof c !== "object") throw new ConfigError("config is not an object");
  if (!PROVIDER_NAMES.includes(c.provider)) errs.push(`provider must be one of ${PROVIDER_NAMES.join("|")}`);
  for (const r of ROLES) {
    const s = c.roles?.[r];
    if (!s) { errs.push(`roles.${r} missing`); continue; }
    if (typeof s.model !== "string" || !s.model) errs.push(`roles.${r}.model missing`);
    if (!["low", "medium", "high", "xhigh", "max"].includes(s.effort)) errs.push(`roles.${r}.effort invalid`);
    if (!Number.isInteger(s.maxTokens) || s.maxTokens < 256) errs.push(`roles.${r}.maxTokens invalid`);
    if (s.model && /-\d{8}$/.test(s.model)) errs.push(`roles.${r}.model must not carry a date suffix`);
  }
  if (c.roles?.auditor && c.roles?.builder && c.roles.auditor.model === c.roles.builder.model && !c.allowSameModelAudit) {
    errs.push("auditor.model equals builder.model (independence rule); set allowSameModelAudit:true to override");
  }
  for (const m of new Set(Object.values(c.roles ?? {}).flatMap((s) => [s?.model, s?.fallbackModel]).filter(Boolean))) {
    const p = c.prices?.[m];
    if (!p || typeof p.in !== "number" || typeof p.out !== "number") errs.push(`prices.${m} missing (in/out USD per 1M)`);
    else for (const k of ["cacheReadMult", "cacheWriteMult"]) if (p[k] != null && !(p[k] >= 0)) errs.push(`prices.${m}.${k} invalid`);
  }
  const l = c.limits ?? {};
  if (!Number.isInteger(l.maxCorrectionRounds) || l.maxCorrectionRounds < 0) errs.push("limits.maxCorrectionRounds invalid");
  if (!Number.isInteger(l.maxReplans) || l.maxReplans < 0) errs.push("limits.maxReplans invalid");
  if (c.budgetUsd != null && !(Number(c.budgetUsd) > 0)) errs.push("budgetUsd must be > 0 or null");
  if (errs.length) throw new ConfigError("invalid config:\n - " + errs.join("\n - "));
  return c;
}

/** Load config file, apply env overrides (ORCH_PROVIDER, ORCH_BUDGET_USD) and validate. */
export function loadConfig({ file, env = process.env, overrides = {} } = {}) {
  const f = file ?? path.join(PROJECT_ROOT, "orchestrator.config.json");
  let raw;
  try { raw = JSON.parse(fs.readFileSync(f, "utf8")); }
  catch (e) { throw new ConfigError(`cannot read config ${f}: ${e.message}`); }
  const c = structuredClone(raw);
  if (env.ORCH_PROVIDER) c.provider = env.ORCH_PROVIDER;
  if (env.ORCH_BUDGET_USD) c.budgetUsd = Number(env.ORCH_BUDGET_USD);
  for (const [k, v] of Object.entries(overrides)) if (v !== undefined && v !== null) c[k] = v;
  if (overrides.maxCorrectionRounds != null) {
    c.limits.maxCorrectionRounds = overrides.maxCorrectionRounds;
    delete c.maxCorrectionRounds;
  }
  return validateConfig(c);
}
