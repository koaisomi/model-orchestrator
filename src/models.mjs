/** Role -> model spec, price lookup, fallback capability. */

export function roleSpec(config, role) {
  const s = config.roles[role];
  if (!s) throw new Error(`unknown role ${role}`);
  return s;
}

/** Price per 1M tokens, or null when the model is not in the table (mock, "unverified"). */
export function priceOf(config, model) {
  return config.prices?.[model] ?? null;
}

/** Server-side refusal fallbacks exist for fable/opus/sonnet; Haiku has none. */
const FALLBACK_IDS = new Set(["claude-fable-5-2", "claude-opus-5-5", "claude-sonnet-5-5"]);

/** Server-side refusal fallbacks exist only for these exact ids (not a name pattern); Haiku has none. */
export function supportsServerFallbacks(model) {
  return FALLBACK_IDS.has(model);
}
