import { createAnthropicProvider } from "./anthropic.mjs";
import { createClaudeCliProvider } from "./claude-cli.mjs";
import { createMockProvider } from "./mock.mjs";

export { ProviderError } from "./anthropic.mjs";

/** @param {string} name @param {{config:object, client?:any, spawnFn?:any, script?:object}} o */
export function getProvider(name, { config, client, spawnFn, script } = {}) {
  switch (name) {
    case "anthropic": return createAnthropicProvider({ client, config });
    case "claude-cli": return createClaudeCliProvider({ spawnFn });
    case "mock": return createMockProvider({ script });
    default: throw new Error(`unknown provider "${name}" (anthropic|claude-cli|mock)`);
  }
}

export async function capabilityReport(config) {
  const out = {};
  for (const n of ["anthropic", "claude-cli", "mock"]) out[n] = await getProvider(n, { config }).capabilityCheck();
  return out;
}
