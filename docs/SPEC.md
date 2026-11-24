# Model Orchestrator — Build Spec v1

Author: orchestrator session (Opus 5.5, planning role). Date: 2026-11-18.
Source policy: Owner's "Autonomous Multi-Model Orchestration Framework" + "Multi_Model_Orchestration_Complete_Guide.pdf" v1.0.

## 0. Goal

A runnable Node controller that takes an engineering task, classifies it, routes it through Fable / Haiku / Sonnet / Opus by **real** API calls, keeps structured hand-offs, gates risky steps behind human approval, runs an audit → correct → validate loop, and records every step with evidence (which model actually answered, tokens, cost).

Hard rule: **never pretend a model ran.** If a provider is not configured, the step is `BLOCKED` with a reason. Every step record stores `requestedModel` and `servedModel` (from the API response `model` field). Mock output is labelled `provider: "mock"` everywhere it appears and the report header says `MOCK RUN — no model was called`.

## 1. Stack and layout

- Node >= 22 (dev box has 26), ESM `.mjs`, JSDoc types. No build step.
- Runtime dependency: `@anthropic-ai/sdk` only. Dev/test: `node:test` + `node:assert` (no extra deps).
- PDF build uses Playwright if found (see §11); it is optional and not a runtime dependency.
- Location: `GROUND ZERO/WORKSPACE/apps/model-orchestrator/`

```
package.json            "type":"module", bin: orchestrate -> bin/orchestrate.mjs, scripts: test, guide:pdf
README.md               setup, config, CLI usage, safety model, limits
.env.example            ANTHROPIC_API_KEY=  (never a real value)
orchestrator.config.json default config (models, effort, limits, prices, gates)
bin/orchestrate.mjs     CLI
src/
  config.mjs            load + validate config, env overrides
  models.mjs            role -> model id, effort, price table
  classify.mjs          rule-based classifier (+ optional Haiku assist)
  router.mjs            level -> route (ordered phases)
  state.mjs             task state machine (allowed transitions, throws on illegal)
  handoff.mjs           build + validate hand-off contract (Appendix A of the guide)
  roles/prompts.mjs     system prompts per role (planner, retriever, builder, auditor, validator)
  schemas.mjs           JSON schemas for structured outputs (plan, extraction, build, audit, validation)
  providers/
    index.mjs           pick provider: anthropic | claude-cli | mock ; capability check
    anthropic.mjs       @anthropic-ai/sdk provider
    claude-cli.mjs      `claude -p` provider (optional, subscription users)
    mock.mjs            deterministic scripted provider for tests / dry runs
  retrieve.mjs          safe local file reader (allowlisted root, caps, secret-file deny list)
  redact.mjs            secret redaction for logs/hand-offs
  gates.mjs             approval gates (interactive prompt, --approve, or deny)
  ledger.mjs            run folder: events.jsonl, decisions.md, changelog.md, handoffs/, proposals/
  apply.mjs             apply builder proposals into target dir (approval-gated, path-safe)
  cost.mjs              usage x price -> USD, per step and per run
  report.mjs            orchestrator dashboard (guide §5.13) text + JSON
  orchestrator.mjs      the pipeline engine
test/                   node:test files, all offline (mock provider + fakes)
docs/
  SPEC.md               this file
  guide.html            technical guide source (print CSS)
  build-pdf.mjs         HTML -> PDF
  Model-Orchestrator-Technical-Guide.pdf  (built output, committed)
examples/
  sample-task.md        low-risk pilot task + tiny sample project folder to run against
```

## 2. Models and roles (config defaults)

| Role | Model id | Effort | Purpose |
|---|---|---|---|
| planner | `claude-fable-5-2` | high | requirements, architecture, spec, acceptance criteria |
| planner fallback | `claude-opus-5-5` | high | when Fable unavailable / refuses / errors 404/403 |
| retriever | `claude-haiku-5-5` | low | extract facts from files the controller read |
| builder | `claude-sonnet-5-5` | medium | produce code changes as proposals |
| auditor | `claude-opus-5-5` | high | independent audit, severity findings |
| validator | `claude-opus-5-5` | high | final PASS/FAIL/BLOCKED/PARTIAL |

Model ids are exact strings, no date suffix. Prices (USD per 1M in/out) in config: fable-5-2 8/40, opus-5-5 4/20, sonnet-5-5 2/10, haiku-5-5 0.10/0.50. Mark them "verify on pricing page" in README.

Independence rule: auditor and validator calls get a **fresh** message history (no builder conversation), the spec, the hand-off, and the actual proposal file contents — never only the builder's summary. Config validation rejects `auditor.model == builder.model` unless `allowSameModelAudit: true`.

## 3. Anthropic provider (src/providers/anthropic.mjs) — exact API rules

- `import Anthropic from "@anthropic-ai/sdk"`; `new Anthropic()` (credentials from env / `ant auth login` profile; never hardcode, never log).
- Use streaming + `await stream.finalMessage()` (max_tokens default 32000, configurable per role).
- Effort: `output_config: { effort }`. Thinking: omit the param (adaptive by default on these models). **Never** send `budget_tokens`, `temperature`, `top_p`, `top_k`, assistant prefill, or forced `tool_choice` `any`/`tool` (all 400 on these models).
- Structured output: `output_config: { effort, format: { type: "json_schema", schema } }`; parse the text block with `JSON.parse`, validate against the schema in code (required keys, enums) — on failure, one retry with the validation error appended, then the step FAILS.
- Refusal fallbacks for fable/opus/sonnet: call `client.beta.messages.stream({... betas: ["server-side-fallback-2026-07-01"], fallbacks: "default" })`; config flag `serverFallbacks: true` (on by default). Haiku: no fallbacks param. Detect fallback by `usage.iterations` entries with `type === "fallback_message"` or content blocks of `type === "fallback"`; record `fallbackRan` + `servedModel = response.model`.
- Always check `stop_reason` before reading content: `refusal` -> step FAILED with `stop_details.category`; `max_tokens` -> FAILED "truncated, raise max_tokens"; only `end_turn` is success.
- Errors: catch most specific first — `Anthropic.AuthenticationError`/`PermissionDeniedError` -> BLOCKED (provider not usable); `NotFoundError` -> model unavailable -> try role fallback model, record substitution; `RateLimitError` / `APIError` 5xx -> SDK retries (maxRetries 2) then FAILED; `APIConnectionError` -> FAILED. Never string-match messages.
- `capabilityCheck()`: returns `{available, reason}`. Has credentials if `ANTHROPIC_API_KEY` or `ANTHROPIC_AUTH_TOKEN` set, or an `ant` profile exists. Optional `--probe` does `client.models.retrieve(id)` for each configured model (no tokens spent) and reports which models the account can use.

## 4. Claude CLI provider (optional)

`claude -p --model <id> --output-format json` with the prompt on stdin, `--effort` if supported else omitted. Parse JSON result; `servedModel` from the result's model usage field if present, else `"unverified"` and the report says so. Timeout 120 s (cold start is slow on this PC: 11-35 s). Spawn with `shell:false`, args array, no user text in argv. Kill child on timeout. No tool permissions (`--allowedTools ""` / disallow all tools) — it is used only as a text model.

## 5. Classifier and router

Classifier output: `{complexity, risk, info, reasoning, execution, verification, level, reasons[]}` (enums from guide §5.3).
Rules (keyword + scope, case-insensitive, word-bounded):
- Critical (level 4): auth, login, password, permission, role, payment, billing, credential, secret, token, encryption, PII, personal data, migration, drop table, delete production, deploy production, infrastructure, firewall, DNS.
- Complex (3): new module, architecture, database, schema, integration across, refactor across, multi-service, workflow engine, > 5 files in context.
- Moderate (2): feature, add endpoint, API, workflow, integrate, several files (2-5).
- Simple (1): typo, text, copy, colour/color, style, rename, comment, config value, single file.
Highest matching level wins. `--level N` overrides (logged as a decision). Optional `--assist-classify` asks Haiku for a structured classification; the stricter of rules vs Haiku wins (never lower risk via a model).

Routes (phases in order):
- L1: build → quick-check (Sonnet self-check is NOT an audit; report labels it "basic verification")
- L2: [retrieve if context given] → build → audit (if risk >= medium) → correct loop → validate
- L3: plan → retrieve → spec(plan output) → build → audit → correct loop → validate
- L4: plan → retrieve → build → audit → **approval gate** → validate (and any apply needs a second gate)
Correct loop: max `maxCorrectionRounds` (default 2). Each round: builder gets the audit findings + previous proposal, produces a revised proposal; auditor re-audits fresh. Unresolved Critical/High after max rounds -> status FAIL, escalate to human.
Escalations (guide §5.11): builder output `planFlaw: true` -> back to planner once (re-plan), then continue; auditor finding `category: "architecture"` with severity >= High -> planner re-plan; business/authorization questions -> human gate. Each escalation is an event.

## 6. State machine

States and allowed transitions exactly as the guide's table (NEW, CLASSIFIED, PLANNING, RETRIEVAL, READY_FOR_BUILD, EXECUTING, AUDIT, CORRECTION, APPROVAL_REQUIRED, VALIDATION, COMPLETE, CLOSED, BLOCKED, ESCALATED, CANCELLED). Add: any state -> BLOCKED / CANCELLED; ESCALATED -> PLANNING; BLOCKED -> terminal. Illegal transition throws. Every transition is an event in events.jsonl.

## 7. Hand-off contract

`handoff.mjs` builds the Appendix A structure as a JSON object (project, task, classification, currentState, decisions, evidence, findings by severity, nextAssignment, approval, handoffStatus READY|BLOCKED|NEEDS_CLARIFICATION). Validate required fields before each delegation; missing -> step BLOCKED. Rendered to markdown for the prompt and saved to `handoffs/NN-<role>.json`. Pass through `redact()` before saving or sending.

## 8. Retrieval (controller reads, Haiku extracts)

- `--context <path...>`: files or dirs under `--root` (default cwd). Resolve real paths; reject anything outside root (symlink-safe via `fs.realpath`).
- Deny list: `.env*`, `*.pem`, `*.key`, `id_rsa*`, `*.p12`, `*.pfx`, `credentials*`, `secrets*`, `.git/`, `node_modules/`, `*.sqlite`, binaries (null byte in first 8 KB).
- Caps: 200 KB per file, 2 MB total, 200 files; overflow is reported, never silently truncated (the step lists skipped files).
- Content passes through `redact()` before leaving the machine.
- Haiku returns structured extraction (facts with file refs, dependencies, conventions, unknowns).

## 9. Builder output and apply

Builder never writes to disk itself. Schema: `{summary, planFlaw, planFlawReason, files:[{path, action:"create"|"replace"|"delete", content}], testsSuggested[], limitations[]}`. Controller writes proposals to `runs/<id>/proposals/round-N/` (path-safe join; reject absolute paths, `..`, drive letters, NUL).
`orchestrate apply <runId> --target <dir>`: only after final status PASS (or `--force-partial` with explicit gate), shows the file list, requires approval gate, path-safe writes inside target, `delete` needs its own gate. No shell commands are ever executed by the controller from model output.

## 10. Gates, redaction, ledger, cost, report

- Gates (`gates.mjs`): kinds `level4`, `apply`, `delete`, `forcePartial`. Modes: interactive TTY prompt (type `GO`), `--approve <kind,...>` pre-approval (logged), non-TTY without pre-approval -> deny -> state APPROVAL_REQUIRED -> run ends BLOCKED. Every decision recorded with timestamp and who (`cli-user`).
- `redact.mjs`: two-pass order (lesson from past bug): first `authorization[:=\s]+((bearer|basic|token)\s+)?\S+`, then `bearer\s+\S+`; plus `sk-ant-[\w-]+`, `sk-[\w-]{20,}`, `ghp_\w+`, `xox[bp]-[\w-]+`, AWS `AKIA[0-9A-Z]{16}`, `-----BEGIN [A-Z ]*PRIVATE KEY-----...END`, `password\s*[:=]\s*\S+`, URL query `(token|key|secret|password)=[^&\s]+`. Tests must print/assert real output on a mixed sample including `Authorization: Bearer abc`.
- Ledger: `runs/<runId>/events.jsonl` (append-only), `decisions.md`, `changelog.md`, `run.json` (final state). runId = `YYYYMMDD-HHMMSS-<6 hex>`. `runs/` in .gitignore.
- Cost: per step `{inputTokens, outputTokens, cacheRead, usd}` from `usage` x config prices of the **served** model; run total; `--budget-usd` hard stop before a step whose worst-case (max_tokens x out price + input estimate) would exceed remaining budget -> BLOCKED.
- Report (guide §5.13): TASK, CLASSIFICATION, MODEL ROUTING (requested vs served, provider), EXECUTION PLAN, CURRENT STATUS, FINDINGS (by severity), QUALITY GATE, NEXT ACTION, COST, plus "Not verified" list (anything that did not run). `--json` prints machine form.

## 11. CLI

```
orchestrate doctor [--probe]             provider + model availability, config check
orchestrate classify "<task>" [--context ...]
orchestrate run "<task>" [--task-file f] [--context paths] [--root dir] [--level N]
                [--provider anthropic|claude-cli|mock] [--approve kinds] [--budget-usd N]
                [--max-rounds N] [--dry-run]   (dry-run = mock provider, banner says so)
orchestrate status <runId> | report <runId> [--json]
orchestrate apply <runId> --target <dir> [--approve apply,delete]
orchestrate runs                          list runs
```
Exit codes: 0 PASS, 1 FAIL, 2 BLOCKED, 3 PARTIAL, 4 usage/config error.

## 12. Tests (offline, `npm test`, must all pass)

classifier levels + override + never-lower; router phases per level; state machine legal/illegal; hand-off validation; redact (mixed sample, header-with-scheme case); retrieve (outside-root, symlink escape if supported, deny list, caps report); proposal path safety (`..`, absolute, `C:\`, NUL); gates (non-TTY deny, pre-approve); cost math; schema validation + one retry; anthropic provider with a **fake client** injected (success, refusal, max_tokens, NotFound -> fallback model substitution recorded, auth error -> BLOCKED, fallback-ran detection, request body never contains budget_tokens/temperature/tool_choice any); orchestrator end-to-end with mock provider: L1, L3 with one correction round, L4 blocked without approval, L4 passes with `--approve level4`, audit FAIL after max rounds -> exit 1, builder planFlaw -> re-plan event; report says MOCK RUN; servedModel recorded; no provider configured -> BLOCKED not fake success.

## 13. Guide PDF

`docs/guide.html` -> `docs/Model-Orchestrator-Technical-Guide.pdf` via `docs/build-pdf.mjs`:
find Playwright: `createRequire(<npm root -g>/@playwright/mcp/)` -> `playwright`; chromium `executablePath` `%LOCALAPPDATA%/ms-playwright/chromium_headless_shell-1248/chrome-headless-shell-win64/chrome-headless-shell.exe` if present, else Playwright default; `page.pdf({format:"A4", printBackground:true, margin})`. Script prints clear instructions if Playwright is missing.
Guide sections: 1 overview + "what is real vs mock"; 2 architecture (three layers: orchestration / execution / governance) with an inline SVG diagram; 3 model roles + effort + prices; 4 classification + routing levels table; 5 pipeline + state machine table; 6 hand-off contract (field list + example); 7 provider details (API rules from §3, CLI provider, mock); 8 security model (gates, redaction, retrieval sandbox, no shell from model output, independence rule) + limits (automated review != pentest); 9 setup (Node, `npm install`, credentials via `ant auth login` or env key, `orchestrate doctor --probe`); 10 CLI reference + exit codes; 11 run folder + reading reports; 12 testing (`npm test`, what is covered); 13 pilot plan (guide §7 deployment sequence); 14 troubleshooting (401, 404 model, refusal, max_tokens, rate limit, CLI cold start); 15 cost notes. Print CSS: A4, page numbers in footer, tables not split mid-row, code blocks wrap.

## 14. Acceptance criteria

1. `npm install` then `npm test` passes offline, 0 failures.
2. `orchestrate doctor` runs without credentials and reports BLOCKED provider honestly.
3. `orchestrate run "fix typo in README" --dry-run --root examples/sample-project` completes with MOCK banner, exit 0, run folder written.
4. `orchestrate run "<auth task>" --dry-run` without `--approve level4` ends BLOCKED (exit 2) at APPROVAL_REQUIRED.
5. No code path writes outside `runs/` except `apply` behind a gate; no code path executes model output.
6. Request bodies match §3 rules (verified by fake-client tests).
7. PDF exists, opens, >= 12 pages, has every §13 section.
8. README covers setup, config, CLI, safety, limits.
