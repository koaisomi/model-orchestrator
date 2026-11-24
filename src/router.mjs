import { RISK_RANK } from "./classify.mjs";

/**
 * Ordered phases for a level. "audit" includes the correct loop. "gate" is the level-4 approval.
 * @param {number} level
 * @param {{hasContext?:boolean, risk?:string, rulesLevel?:number}} [o]
 * @returns {string[]}
 */
export function route(level, { hasContext = false, risk = "low", rulesLevel = 0 } = {}) {
  // the approval gate is required whenever risk is critical or the rules said level 4, whatever level was requested
  if (level === 4 || risk === "critical" || rulesLevel === 4) level = 4;
  const r = [];
  if (level >= 3) r.push("plan");
  if (level >= 3 ? hasContext : level === 2 && hasContext) r.push("retrieve");
  r.push("build");
  if (level === 1) return [...r, "quick-check"];
  if (level >= 3 || RISK_RANK[risk] >= RISK_RANK.medium) r.push("audit");
  if (level === 4) r.push("gate");
  r.push("validate");
  return r;
}
