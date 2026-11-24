import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ProviderError } from "./anthropic.mjs";

export const CLI_TIMEOUT_MS = 120_000; // cold start on this PC takes 11-35 s

/** Find the claude binary on PATH without running it (PATHEXT aware, win32 safe). */
export function findClaude(env = process.env) {
  if (env.ORCH_CLAUDE_BIN) return fs.existsSync(env.ORCH_CLAUDE_BIN) ? env.ORCH_CLAUDE_BIN : null;
  const exts = process.platform === "win32" ? [".exe", ".cmd", ".bat", ""] : [""];
  for (const d of (env.PATH ?? env.Path ?? "").split(path.delimiter).filter(Boolean)) {
    for (const e of exts) { const f = path.join(d, "claude" + e); if (fs.existsSync(f)) return f; }
  }
  return null;
}

/**
 * Isolation flags: the child must be a plain text model. No MCP servers, no connectors, no project/user hooks or
 * plugins from settings, no saved session, no tools. (--setting-sources "" is verified live in the smoke test;
 * the fallback is "user", see README limitations.)
 */
export function cliArgs(model, effort, settingSources = "") {
  return ["-p", "--model", model, "--output-format", "json", "--tools", "", "--strict-mcp-config", "--setting-sources", settingSources, "--disallowedTools", "mcp__*", "--no-session-persistence", ...(effort ? ["--effort", effort] : [])];
}

const render = (req) =>
  [
    "SYSTEM INSTRUCTIONS:", req.system, "",
    ...req.messages.map((m) => `${m.role.toUpperCase()}:\n${m.content}\n`),
    req.schema ? `Reply with ONLY one JSON object matching this JSON schema, no prose, no code fence:\n${JSON.stringify(req.schema)}` : "",
  ].join("\n");

/** Which modelUsage key served the request. Never "first key": exact or dated-variant match, else unverified. */
export function pickServedModel(modelUsage, requested) {
  const keys = modelUsage && typeof modelUsage === "object" ? Object.keys(modelUsage) : [];
  const hit = keys.find((k) => k === requested) ?? keys.find((k) => k.startsWith(requested + "-"));
  if (hit) return { served: hit, note: keys.length > 1 ? `other models also used by the CLI: ${keys.filter((k) => k !== hit).join(", ")}` : null };
  if (keys.length === 1) return { served: keys[0], note: `CLI reported ${keys[0]} but ${requested} was requested` };
  return { served: "unverified", note: keys.length ? `several models reported (${keys.join(", ")}) and none matches ${requested}` : "the CLI reported no model usage" };
}

/**
 * `claude -p` as a text-only model, using the user's Claude Code login. Prompt goes on stdin (no user text in argv),
 * shell:false, all tools and MCP disabled, cwd = a fresh empty temp dir that is removed afterwards.
 * @param {{spawnFn?:typeof spawn, bin?:string|null, timeoutMs?:number, env?:object, settingSources?:string}} [o]
 */
export function createClaudeCliProvider({ spawnFn = spawn, bin, timeoutMs = CLI_TIMEOUT_MS, env = process.env, settingSources = "" } = {}) {
  return {
    name: "claude-cli",
    costsMoney: true, // may report cost; unpriced use is labelled "subscription — not metered" and cannot satisfy a budget
    async capabilityCheck() {
      const b = bin ?? findClaude(env);
      return b ? { available: true, reason: `claude binary found: ${b} (login state not verified)` } : { available: false, reason: "claude binary not found on PATH (set ORCH_CLAUDE_BIN)" };
    },
    /** One tiny real call (haiku, 1 word) to prove auth with the isolation flags. */
    async probe(model) {
      const r = await this.complete({ kind: "probe", role: "retriever", model, effort: "low", system: "Reply with exactly the single word OK.", messages: [{ role: "user", content: "ping" }] });
      return { servedModel: r.servedModel, note: r.servedNote, text: r.text.slice(0, 40), reportedUsd: r.reportedUsd ?? null };
    },
    async complete(req) {
      const b = bin ?? findClaude(env);
      if (!b) throw new ProviderError("blocked", "claude binary not found");
      const args = cliArgs(req.model, req.effort, settingSources);
      const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "orch-cli-"));
      let out;
      try {
        out = await new Promise((resolve, reject) => {
          const child = spawnFn(b, args, { shell: false, windowsHide: true, cwd, stdio: ["pipe", "pipe", "pipe"] });
          let so = "", se = "", done = false;
          const timer = setTimeout(() => { if (!done) { done = true; child.kill(); reject(new ProviderError("failed", `claude -p timed out after ${timeoutMs / 1000}s`)); } }, timeoutMs);
          child.stdout.on("data", (d) => (so += d));
          child.stderr.on("data", (d) => (se += d));
          child.on("error", (e) => { if (!done) { done = true; clearTimeout(timer); reject(new ProviderError("blocked", `cannot start claude: ${e.code ?? e.message}`)); } });
          child.on("close", (code) => { if (!done) { done = true; clearTimeout(timer); code === 0 ? resolve(so) : reject(new ProviderError("failed", `claude -p exited ${code}: ${(se || so).slice(0, 300)}`)); } });
          child.stdin.on("error", () => {});
          child.stdin.end(render(req));
        });
      } finally {
        try { fs.rmSync(cwd, { recursive: true, force: true }); } catch { /* temp dir we created */ }
      }
      let j;
      try { j = JSON.parse(out); } catch { throw new ProviderError("failed", "claude -p did not return JSON"); }
      if (j.is_error) throw new ProviderError("failed", `claude -p reported an error: ${String(j.result).slice(0, 300)}`);
      const { served, note } = pickServedModel(j.modelUsage, req.model);
      const entries = j.modelUsage && typeof j.modelUsage === "object" ? Object.entries(j.modelUsage) : [];
      const num = (o, ...ks) => ks.map((k) => o?.[k]).find((v) => typeof v === "number") ?? 0;
      const iterations = entries.map(([model, u]) => ({ model, inputTokens: num(u, "inputTokens", "input_tokens"), outputTokens: num(u, "outputTokens", "output_tokens"), cacheRead: num(u, "cacheReadInputTokens", "cache_read_input_tokens"), cacheWrite: num(u, "cacheCreationInputTokens", "cache_creation_input_tokens") }));
      const sum = (k) => iterations.reduce((n, i) => n + i[k], 0);
      const u0 = j.usage ?? {};
      return {
        text: String(j.result ?? ""),
        provider: "claude-cli",
        requestedModel: req.model,
        servedModel: served,
        servedNote: note,
        usage: iterations.length
          ? { inputTokens: sum("inputTokens"), outputTokens: sum("outputTokens"), cacheRead: sum("cacheRead"), cacheWrite: sum("cacheWrite"), iterations }
          : { inputTokens: num(u0, "input_tokens"), outputTokens: num(u0, "output_tokens"), cacheRead: num(u0, "cache_read_input_tokens"), cacheWrite: num(u0, "cache_creation_input_tokens") },
        reportedUsd: typeof j.total_cost_usd === "number" ? j.total_cost_usd : null,
        unmetered: typeof j.total_cost_usd !== "number",
        stopReason: "end_turn",
        fallbackRan: false,
      };
    },
  };
}
