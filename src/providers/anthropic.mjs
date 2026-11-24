import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { supportsServerFallbacks } from "../models.mjs";

export const FALLBACK_BETA = "server-side-fallback-2026-07-01";

/** kind "blocked": provider not usable (stop run, status BLOCKED). kind "failed": this step failed. */
export class ProviderError extends Error {
  constructor(kind, message, extra = {}) { super(message); this.kind = kind; Object.assign(this, extra); }
}

/** Internal: this model attempt can be retried on the role's fallbackModel. */
class FallbackTrigger extends Error {
  constructor(reason, detail) { super(detail); this.reason = reason; }
}

// shortcut: SDK loaded lazily (cold import is ~5 s on this PC) so doctor/classify/report stay fast.
let SDK;
const loadSdk = async () => (SDK ??= (await import("@anthropic-ai/sdk")).default);

const text = (msg) => msg.content.filter((b) => b.type === "text").map((b) => b.text).join("");

/**
 * @param {{client?:any, config:{serverFallbacks:boolean, roles:object}, env?:object}} o
 * `client` is injectable (tests pass a fake). Default: new Anthropic() with maxRetries 2; credentials from env/profile only.
 */
export function createAnthropicProvider({ client, config, env = process.env }) {
  let real = client;
  const getClient = async () => (real ??= new (await loadSdk())({ maxRetries: 2 }));

  /** One attempt on one model. Throws FallbackTrigger / ProviderError. */
  async function attempt(model, req) {
    const output_config = { effort: req.effort };
    if (req.schema) output_config.format = { type: "json_schema", schema: req.schema };
    const body = { model, max_tokens: req.maxTokens ?? 32000, system: req.system, messages: req.messages, output_config };
    const Anthropic = await loadSdk();
    const c = await getClient();
    let stream, msg;
    try {
      if (config.serverFallbacks && supportsServerFallbacks(model)) {
        stream = c.beta.messages.stream({ ...body, betas: [FALLBACK_BETA], fallbacks: "default" });
      } else {
        stream = c.messages.stream(body);
      }
      msg = await stream.finalMessage();
    } catch (e) {
      // most specific first; never string-match messages
      if (e instanceof Anthropic.AuthenticationError) throw new ProviderError("blocked", "authentication failed (check credentials)", { status: 401 });
      if (e instanceof Anthropic.PermissionDeniedError) throw new FallbackTrigger("permission-denied", `403 on ${model}`);
      if (e instanceof Anthropic.NotFoundError) throw new FallbackTrigger("not-found", `404 model ${model} unavailable`);
      if (e instanceof Anthropic.BadRequestError) throw new ProviderError("failed", `bad request (400): ${e.message}`, { status: 400 });
      if (e instanceof Anthropic.RateLimitError) throw new ProviderError("failed", "rate limited (429) after SDK retries", { status: 429 });
      if (e instanceof Anthropic.APIConnectionError) throw new ProviderError("failed", `connection error: ${e.message}`);
      if (e instanceof Anthropic.APIError) throw new ProviderError("failed", `API error ${e.status}: ${e.message}`, { status: e.status });
      throw e;
    }
    // stop_reason BEFORE content
    if (msg.stop_reason === "refusal") {
      const cat = msg.stop_details?.category ?? "unknown";
      throw new FallbackTrigger("refusal", `refusal (category: ${cat})`);
    }
    if (msg.stop_reason === "max_tokens") throw new ProviderError("failed", "truncated (max_tokens): raise max_tokens for this role");
    if (msg.stop_reason !== "end_turn") throw new ProviderError("failed", `unexpected stop_reason ${msg.stop_reason}`);
    const u = msg.usage ?? {};
    const fallbackRan = (u.iterations ?? []).some((i) => i.type === "fallback_message") || msg.content.some((b) => b.type === "fallback");
    // per-iteration usage so each iteration is priced by the model that ran it (shortcut: assumes iteration entries carry model + token fields; entries without them are ignored and the totals are used)
    const iterations = (u.iterations ?? []).filter((i) => typeof i.input_tokens === "number" || typeof i.output_tokens === "number").map((i) => ({ type: i.type, model: i.model ?? null, inputTokens: i.input_tokens ?? 0, outputTokens: i.output_tokens ?? 0, cacheRead: i.cache_read_input_tokens ?? 0, cacheWrite: i.cache_creation_input_tokens ?? 0 }));
    return {
      text: text(msg),
      provider: "anthropic",
      requestedModel: model,
      servedModel: msg.model, // from the response, never assumed
      usage: { inputTokens: u.input_tokens ?? 0, outputTokens: u.output_tokens ?? 0, cacheRead: u.cache_read_input_tokens ?? 0, cacheWrite: u.cache_creation_input_tokens ?? 0, ...(iterations.length ? { iterations } : {}) },
      stopReason: msg.stop_reason,
      fallbackRan,
    };
  }

  return {
    name: "anthropic",
    costsMoney: true,
    async capabilityCheck() {
      if (env.ANTHROPIC_API_KEY) return { available: true, reason: "ANTHROPIC_API_KEY is set" };
      if (env.ANTHROPIC_AUTH_TOKEN) return { available: true, reason: "ANTHROPIC_AUTH_TOKEN is set" };
      // heuristic: `ant auth login` stores a profile under ~/.config/anthropic (unverified on Windows)
      const home = env.USERPROFILE ?? env.HOME ?? os.homedir();
      for (const d of [path.join(home, ".config", "anthropic"), env.APPDATA && path.join(env.APPDATA, "anthropic")].filter(Boolean)) {
        try { if (fs.readdirSync(d).length) return { available: true, reason: `ant profile directory found (${d}; heuristic, not validated)` }; } catch { /* none */ }
      }
      return { available: false, reason: "no credentials: set ANTHROPIC_API_KEY or ANTHROPIC_AUTH_TOKEN, or run `ant auth login`" };
    },
    /** client.models.retrieve per model (no tokens spent). */
    async probe(models) {
      const Anthropic = await loadSdk();
      const out = {};
      for (const m of models) {
        try { await (await getClient()).models.retrieve(m); out[m] = { usable: true }; }
        catch (e) {
          out[m] = { usable: false, reason: e instanceof Anthropic.AuthenticationError ? "authentication failed" : e instanceof Anthropic.NotFoundError ? "model not found for this account" : e instanceof Anthropic.PermissionDeniedError ? "permission denied" : `error: ${e.constructor?.name}` };
        }
      }
      return out;
    },
    /** @param {{model:string, fallbackModel?:string}} req */
    async complete(req) {
      const order = [req.model, ...(req.fallbackModel && req.fallbackModel !== req.model ? [req.fallbackModel] : [])];
      let firstReason = null;
      for (let i = 0; i < order.length; i++) {
        try {
          if (i > 0) req.preflight?.({ model: order[i], system: req.system, messages: req.messages, maxTokens: req.maxTokens });
          const r = await attempt(order[i], req);
          if (i > 0) r.substitution = { from: req.model, to: order[i], reason: firstReason };
          r.requestedModel = req.model;
          return r;
        } catch (e) {
          if (e instanceof FallbackTrigger) {
            firstReason ??= e.reason;
            if (i < order.length - 1) continue;
            throw new ProviderError("failed", `${e.message}; no further fallback model configured`, { reason: e.reason });
          }
          throw e;
        }
      }
    },
  };
}
