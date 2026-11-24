import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Anthropic from "@anthropic-ai/sdk";
import { createAnthropicProvider, ProviderError, FALLBACK_BETA } from "../src/providers/anthropic.mjs";
import { createClaudeCliProvider } from "../src/providers/claude-cli.mjs";
import { createMockProvider } from "../src/providers/mock.mjs";
import { callStructured } from "../src/schemas.mjs";
import { loadConfig } from "../src/config.mjs";

const config = loadConfig({ env: {} });
const err = (Cls, status) => new Cls(status, { type: "error", error: { type: "x", message: "boom" } }, "boom", new Headers());

const msg = (o = {}) => ({
  model: o.model ?? "claude-opus-5-5",
  stop_reason: o.stop_reason ?? "end_turn",
  stop_details: o.stop_details ?? null,
  content: o.content ?? [{ type: "text", text: o.text ?? '{"ok":true,"issues":[]}' }],
  usage: o.usage ?? { input_tokens: 100, output_tokens: 50, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
});

/** fake SDK client: each stream() call pops the next handler (a message or a thrower). Records every body. */
function fake(handlers) {
  const calls = [];
  const mk = (via) => ({
    stream(body) {
      calls.push({ via, body });
      const h = handlers.length > 1 ? handlers.shift() : handlers[0];
      return { finalMessage: async () => (typeof h === "function" ? h(body) : h) };
    },
  });
  return { messages: mk("messages"), beta: { messages: mk("beta") }, models: { retrieve: async (id) => ({ id }) }, calls };
}
const req = (model, extra = {}) => ({ kind: "quickcheck", role: "builder", model, effort: "medium", maxTokens: 1000, system: "sys", messages: [{ role: "user", content: "hi" }], schema: { type: "object" }, ...extra });
const prov = (client) => createAnthropicProvider({ client, config });

test("anthropic: success records served model from the response, usage, fallbackRan false", async () => {
  const c = fake([msg({ model: "claude-sonnet-5-5" })]);
  const r = await prov(c).complete(req("claude-sonnet-5-5"));
  assert.equal(r.provider, "anthropic");
  assert.equal(r.requestedModel, "claude-sonnet-5-5");
  assert.equal(r.servedModel, "claude-sonnet-5-5");
  assert.deepEqual(r.usage, { inputTokens: 100, outputTokens: 50, cacheRead: 0, cacheWrite: 0 });
  assert.equal(r.fallbackRan, false);
  assert.equal(r.text, '{"ok":true,"issues":[]}');
});

test("anthropic: request body follows the API rules (no forbidden params, effort in output_config)", async () => {
  const c = fake([msg()]);
  await prov(c).complete(req("claude-opus-5-5"));
  const { via, body } = c.calls[0];
  assert.equal(via, "beta");
  assert.deepEqual(body.betas, [FALLBACK_BETA]);
  assert.equal(body.fallbacks, "default");
  assert.equal(body.output_config.effort, "medium");
  assert.equal(body.output_config.format.type, "json_schema");
  assert.equal(body.max_tokens, 1000);
  const json = JSON.stringify(body);
  for (const bad of ["budget_tokens", "temperature", "top_p", "top_k", "thinking", "prefill"]) assert.ok(!json.includes(bad), bad);
  assert.equal(body.tool_choice, undefined);
  assert.equal(body.messages.at(-1).role, "user"); // no assistant prefill
});

test("anthropic: haiku uses plain messages.stream, no fallbacks param; serverFallbacks:false honoured", async () => {
  const c = fake([msg({ model: "claude-haiku-5-5" })]);
  await prov(c).complete(req("claude-haiku-5-5", { role: "retriever", effort: "low" }));
  assert.equal(c.calls[0].via, "messages");
  assert.equal(c.calls[0].body.fallbacks, undefined);
  assert.equal(c.calls[0].body.betas, undefined);
  const c2 = fake([msg()]);
  await createAnthropicProvider({ client: c2, config: { ...config, serverFallbacks: false } }).complete(req("claude-opus-5-5"));
  assert.equal(c2.calls[0].via, "messages");
  assert.equal(c2.calls[0].body.fallbacks, undefined);
});

test("anthropic: no schema -> no format key", async () => {
  const c = fake([msg()]);
  await prov(c).complete(req("claude-opus-5-5", { schema: undefined }));
  assert.equal(c.calls[0].body.output_config.format, undefined);
});

test("anthropic: refusal -> FAILED with category (no fallback model)", async () => {
  const c = fake([msg({ stop_reason: "refusal", stop_details: { type: "refusal", category: "cyber", explanation: "x" }, content: [] })]);
  await assert.rejects(prov(c).complete(req("claude-sonnet-5-5")), (e) => e instanceof ProviderError && e.kind === "failed" && /refusal \(category: cyber\)/.test(e.message));
});

test("anthropic: max_tokens -> FAILED truncated, content not trusted", async () => {
  const c = fake([msg({ stop_reason: "max_tokens", text: '{"half":' })]);
  await assert.rejects(prov(c).complete(req("claude-opus-5-5")), (e) => e.kind === "failed" && /truncated/.test(e.message));
});

test("anthropic: pause_turn / other stop reasons are not success", async () => {
  await assert.rejects(prov(fake([msg({ stop_reason: "pause_turn" })])).complete(req("claude-opus-5-5")), /unexpected stop_reason/);
});

test("anthropic: 404 on planner -> substitutes role fallback model and records it", async () => {
  const c = fake([() => { throw err(Anthropic.NotFoundError, 404); }, msg({ model: "claude-opus-5-5" })]);
  const r = await prov(c).complete(req("claude-fable-5-2", { role: "planner", fallbackModel: "claude-opus-5-5" }));
  assert.equal(c.calls.length, 2);
  assert.equal(c.calls[0].body.model, "claude-fable-5-2");
  assert.equal(c.calls[1].body.model, "claude-opus-5-5");
  assert.deepEqual(r.substitution, { from: "claude-fable-5-2", to: "claude-opus-5-5", reason: "not-found" });
  assert.equal(r.requestedModel, "claude-fable-5-2");
  assert.equal(r.servedModel, "claude-opus-5-5");
});

test("anthropic: 404 without a fallback model -> FAILED model unavailable", async () => {
  const c = fake([() => { throw err(Anthropic.NotFoundError, 404); }]);
  await assert.rejects(prov(c).complete(req("claude-sonnet-5-5")), (e) => e.kind === "failed" && /unavailable/.test(e.message));
});

test("anthropic: refusal on planner also falls back to the role fallback model", async () => {
  const c = fake([msg({ stop_reason: "refusal", content: [], stop_details: { category: "bio" } }), msg({ model: "claude-opus-5-5" })]);
  const r = await prov(c).complete(req("claude-fable-5-2", { fallbackModel: "claude-opus-5-5" }));
  assert.equal(r.substitution.reason, "refusal");
});

test("anthropic: 401 -> BLOCKED; 403 without fallback -> failed(403 reason); both typed, no string match", async () => {
  await assert.rejects(prov(fake([() => { throw err(Anthropic.AuthenticationError, 401); }])).complete(req("claude-opus-5-5")), (e) => e.kind === "blocked");
  const c = fake([() => { throw err(Anthropic.PermissionDeniedError, 403); }, msg({ model: "claude-opus-5-5" })]);
  const r = await prov(c).complete(req("claude-fable-5-2", { fallbackModel: "claude-opus-5-5" }));
  assert.equal(r.substitution.reason, "permission-denied");
});

test("anthropic: 429, 500, connection error -> FAILED", async () => {
  await assert.rejects(prov(fake([() => { throw err(Anthropic.RateLimitError, 429); }])).complete(req("claude-opus-5-5")), (e) => e.kind === "failed" && e.status === 429);
  await assert.rejects(prov(fake([() => { throw err(Anthropic.InternalServerError, 500); }])).complete(req("claude-opus-5-5")), (e) => e.kind === "failed" && e.status === 500);
  await assert.rejects(prov(fake([() => { throw new Anthropic.APIConnectionError({ message: "down" }); }])).complete(req("claude-opus-5-5")), (e) => e.kind === "failed" && /connection/.test(e.message));
});

test("anthropic: fallback ran detected from usage.iterations and from fallback content block", async () => {
  const a = await prov(fake([msg({ model: "claude-opus-4-8", usage: { input_tokens: 1, output_tokens: 1, iterations: [{ type: "message" }, { type: "fallback_message" }] } })])).complete(req("claude-opus-5-5"));
  assert.equal(a.fallbackRan, true);
  assert.equal(a.servedModel, "claude-opus-4-8");
  const b = await prov(fake([msg({ content: [{ type: "fallback", from: { model: "x" }, to: { model: "y" } }, { type: "text", text: "{}" }] })])).complete(req("claude-opus-5-5"));
  assert.equal(b.fallbackRan, true);
});

test("anthropic: capabilityCheck uses env names only; probe reports per model", async () => {
  const none = createAnthropicProvider({ client: fake([msg()]), config, env: { APPDATA: "Z:\\nope", HOME: "Z:\\nope" } });
  const c1 = await createAnthropicProvider({ config, env: { ANTHROPIC_API_KEY: "x" } }).capabilityCheck();
  assert.equal(c1.available, true);
  assert.ok(!JSON.stringify(c1).includes('"x"') || c1.reason === "ANTHROPIC_API_KEY is set");
  assert.equal((await createAnthropicProvider({ config, env: { ANTHROPIC_AUTH_TOKEN: "t" } }).capabilityCheck()).available, true);
  const emptyHome = fs.mkdtempSync(path.join(os.tmpdir(), "orch-home-"));
  const bare = await createAnthropicProvider({ config, env: { HOME: emptyHome, USERPROFILE: emptyHome, APPDATA: emptyHome } }).capabilityCheck();
  assert.equal(bare.available, false);
  assert.match(bare.reason, /no credentials/);
  assert.equal((await none.capabilityCheck()).available, false);
  const client = fake([msg()]);
  client.models.retrieve = async (id) => { if (id === "claude-fable-5-2") throw err(Anthropic.NotFoundError, 404); return { id }; };
  const p = await prov(client).probe(["claude-fable-5-2", "claude-opus-5-5"]);
  assert.equal(p["claude-fable-5-2"].usable, false);
  assert.equal(p["claude-opus-5-5"].usable, true);
});

test("anthropic + callStructured: invalid JSON retried once through the real provider path", async () => {
  const c = fake([msg({ text: "oops" }), msg({ text: '{"ok":true,"issues":[]}' })]);
  const r = await callStructured(prov(c), { ...req("claude-opus-5-5"), schema: undefined });
  assert.equal(r.attempts, 2);
  assert.equal(c.calls.length, 2);
  assert.equal(c.calls[1].body.messages.length, 3);
  assert.equal(c.calls[1].body.messages.at(-1).role, "user");
});

test("mock provider: labelled mock, never a served model, scripted replies repeat the last", async () => {
  const m = createMockProvider({ script: { quickcheck: [{ ok: false, issues: ["a"] }, { ok: true, issues: [] }] } });
  const a = await m.complete({ kind: "quickcheck", model: "claude-sonnet-5-5" });
  const b = await m.complete({ kind: "quickcheck", model: "claude-sonnet-5-5" });
  const c = await m.complete({ kind: "quickcheck", model: "claude-sonnet-5-5" });
  assert.equal(a.provider, "mock");
  assert.equal(a.servedModel, "mock");
  assert.equal(JSON.parse(a.text).ok, false);
  assert.equal(JSON.parse(b.text).ok, true);
  assert.equal(JSON.parse(c.text).ok, true);
});

function fakeSpawn({ stdout, code = 0, hang = false, spawnError }) {
  const seen = { args: null, opts: null, stdin: "", killed: false };
  const fn = (bin, args, opts) => {
    seen.args = args; seen.opts = opts; seen.bin = bin;
    const child = new EventEmitter();
    child.stdout = new PassThrough(); child.stderr = new PassThrough(); child.stdin = new PassThrough();
    child.stdin.on("data", (d) => (seen.stdin += d));
    child.kill = () => { seen.killed = true; };
    setImmediate(() => {
      if (spawnError) return child.emit("error", Object.assign(new Error("x"), { code: spawnError }));
      if (hang) return;
      child.stdout.end(stdout);
      child.emit("close", code);
    });
    return child;
  };
  return { fn, seen };
}

test("claude-cli: args array, shell:false, prompt on stdin only, tools disabled, served model from modelUsage", async () => {
  const out = JSON.stringify({ result: '{"ok":true,"issues":[]}', modelUsage: { "claude-sonnet-5-5": { inputTokens: 9, outputTokens: 3 } } });
  const { fn, seen } = fakeSpawn({ stdout: out });
  const p = createClaudeCliProvider({ spawnFn: fn, bin: "claude" });
  const r = await p.complete({ kind: "quickcheck", model: "claude-sonnet-5-5", effort: "medium", system: "SYS", messages: [{ role: "user", content: "SECRET-USER-TEXT" }], schema: { type: "object" } });
  assert.equal(seen.opts.shell, false);
  assert.ok(Array.isArray(seen.args));
  assert.ok(!seen.args.join(" ").includes("SECRET-USER-TEXT"));
  assert.ok(!seen.args.join(" ").includes("SYS"));
  assert.match(seen.stdin, /SECRET-USER-TEXT/);
  const i = seen.args.indexOf("--tools");
  assert.equal(seen.args[i + 1], "");
  assert.equal(r.servedModel, "claude-sonnet-5-5");
  assert.equal(r.provider, "claude-cli");
  assert.equal(r.usage.inputTokens, 9);
});

test("claude-cli: served model unverified when not reported; timeout kills child; spawn error BLOCKED; bad JSON FAILED", async () => {
  const { fn } = fakeSpawn({ stdout: JSON.stringify({ result: "{}" }) });
  const r = await createClaudeCliProvider({ spawnFn: fn, bin: "claude" }).complete({ kind: "x", model: "m", effort: "low", system: "s", messages: [] });
  assert.equal(r.servedModel, "unverified");
  const h = fakeSpawn({ hang: true });
  await assert.rejects(createClaudeCliProvider({ spawnFn: h.fn, bin: "claude", timeoutMs: 30 }).complete({ model: "m", effort: "low", system: "s", messages: [] }), /timed out/);
  assert.equal(h.seen.killed, true);
  await assert.rejects(createClaudeCliProvider({ spawnFn: fakeSpawn({ spawnError: "ENOENT" }).fn, bin: "claude" }).complete({ model: "m", effort: "low", system: "s", messages: [] }), (e) => e.kind === "blocked");
  await assert.rejects(createClaudeCliProvider({ spawnFn: fakeSpawn({ stdout: "nope" }).fn, bin: "claude" }).complete({ model: "m", effort: "low", system: "s", messages: [] }), /JSON/);
});
