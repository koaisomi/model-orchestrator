import { priceOf } from "./models.mjs";

const PER = 1_000_000;

function oneCost(p, u) {
  const { inputTokens = 0, outputTokens = 0, cacheRead = 0, cacheWrite = 0 } = u;
  return (inputTokens * p.in + outputTokens * p.out + cacheRead * p.in * (p.cacheReadMult ?? 0.1) + cacheWrite * p.in * (p.cacheWriteMult ?? 1.25)) / PER;
}

/**
 * USD for one call. When usage.iterations is present (server fallback ran), EACH iteration is priced by the model
 * that ran it (iteration.model, else the served model, flagged). Cache multipliers come from config per model.
 * Unknown model price -> priceKnown:false and the model is listed in unknownModels (mock, "unverified").
 * @returns {{usd:number, priceKnown:boolean, unknownModels:string[]}}
 */
export function stepCost(config, servedModel, usage = {}) {
  const parts = usage.iterations?.length ? usage.iterations.map((i) => ({ model: i.model ?? servedModel, u: i })) : [{ model: servedModel, u: usage }];
  let usd = 0;
  const unknownModels = [];
  for (const { model, u } of parts) {
    const p = priceOf(config, model);
    if (!p) { if (!unknownModels.includes(model)) unknownModels.push(model); continue; }
    usd += oneCost(p, u);
  }
  return { usd, priceKnown: unknownModels.length === 0, unknownModels };
}

/** Worst case for a call about to run: estimated input (chars/3, conservative) + full max_tokens output. Unknown price -> Infinity. */
export function worstCase(config, model, maxTokens, inputChars) {
  const p = priceOf(config, model);
  if (!p) return Infinity;
  return (Math.ceil(inputChars / 3) * p.in + maxTokens * p.out) / PER;
}

export function createBudget(limitUsd) {
  let spent = 0;
  return {
    get spent() { return spent; },
    get limit() { return limitUsd; },
    add(usd) { spent += usd; },
    remaining() { return limitUsd == null ? Infinity : limitUsd - spent; },
    /** true when a call with this worst case may NOT run */
    wouldExceed(worst) { return limitUsd != null && worst > limitUsd - spent; },
  };
}
