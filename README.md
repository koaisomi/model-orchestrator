# Model Orchestrator

A Node CLI controller that takes an engineering task, classifies it, and routes it through **Fable / Haiku / Sonnet / Opus** with real Anthropic API calls. It keeps structured hand-offs, gates risky steps behind human approval, runs an audit, correct and validate loop, and records every step with evidence: which model actually answered, tokens and cost.

**Hard rule: it never pretends a model ran.** If no provider is configured the run ends `BLOCKED` with a reason. Every step stores `requestedModel` and `servedModel` (taken from the API response). Mock output is labelled `provider: "mock"` and every mock report starts with `MOCK RUN — no model was called`.

Full technical guide: `docs/Model-Orchestrator-Technical-Guide.pdf` (source `docs/guide.html`). Build spec: `docs/SPEC.md`.

## Setup

Requires Node 22 or newer. One runtime dependency: `@anthropic-ai/sdk`.

```
npm install
npm test                       # offline, no credentials needed
node bin/orchestrate.mjs doctor
```

**Default provider: `claude-cli`.** It runs `claude -p` with your Claude Code login, so real runs need no API key; just be logged in to Claude Code. The Anthropic API stays supported as the alternative (`--provider anthropic` or `"provider": "anthropic"` in the config) and needs one of:

- `ant auth login` (the SDK reads the profile), or
- environment variable `ANTHROPIC_API_KEY`, or `ANTHROPIC_AUTH_TOKEN`.

`.env.example` lists the variable name. Never commit a real value. The tool never reads or prints key values; it only checks whether the variable exists.

`orchestrate doctor --probe` calls `models.retrieve` for each configured model on the Anthropic API (no tokens spent, only when credentials exist) and, for `claude-cli`, makes ONE tiny Haiku call to prove login works with the isolation flags and to show which model the CLI reports.

## Configuration

`orchestrator.config.json` (validated on every start; invalid config exits 4):

| Key | Meaning |
|---|---|
| `provider` | default provider: `claude-cli` (default), `anthropic` or `mock` |
| `roles.<role>` | `model`, `effort` (`low`..`max`), `maxTokens`, optional `fallbackModel` (planner: Opus) |
| `serverFallbacks` | use the server-side refusal fallback beta for fable/opus/sonnet (default true) |
| `allowSameModelAudit` | allow auditor model == builder model (default false: independence rule) |
| `limits.maxCorrectionRounds`, `limits.maxReplans` | correction loop cap (2) and re-plan cap (1) |
| `budgetUsd` | optional hard budget; `--budget-usd` overrides |
| `prices` | USD per 1M tokens in/out plus `cacheReadMult` / `cacheWriteMult` per model (opus and sonnet 5.5 0.05, fable 5.2 0.025, haiku 0.1; write 1.25). **Verify on the Anthropic pricing page**: cost numbers are only as good as this table |

Environment overrides: `ORCH_PROVIDER`, `ORCH_BUDGET_USD`, `ORCH_RUNS_DIR` (where run folders go, default `./runs`), `ORCH_CLAUDE_BIN`.

Default roles: planner `claude-fable-5-2` (high, fallback `claude-opus-5-5`), retriever `claude-haiku-5-5` (low), builder `claude-sonnet-5-5` (medium), auditor and validator `claude-opus-5-5` (high).

## CLI

```
orchestrate doctor [--probe]
orchestrate classify "<task>" [--context paths...] [--root dir]
orchestrate run "<task>" [--task-file f] [--context paths...] [--root dir] [--level N]
        [--provider anthropic|claude-cli|mock] [--approve kinds] [--budget-usd N]
        [--max-rounds N] [--no-assist-classify] [--dry-run]
orchestrate status <runId>
orchestrate report <runId> [--json]
orchestrate apply <runId> --target <dir> [--approve apply,delete,forcePartial]
orchestrate runs
```

Exit codes: `0` PASS, `1` FAIL, `2` BLOCKED, `3` PARTIAL, `4` usage or config error.

Try it without spending anything:

```
node bin/orchestrate.mjs run "fix typo in README" --dry-run --root examples/sample-project
node bin/orchestrate.mjs run "add login and password reset" --dry-run                  # BLOCKED, exit 2
node bin/orchestrate.mjs run "add login and password reset" --dry-run --approve level4 # PASS
```

`--dry-run` forces the mock provider. When `--root` is given without `--context`, the whole root is the context (capped, deny-listed). `--task-file examples/sample-task.md` reads the task from a file.

## Levels and routes

| Level | Triggers | Route |
|---|---|---|
| 1 simple | typo, text, copy, colour, rename, comment | build, basic check (not an audit) |
| 2 moderate | feature, endpoint, API, workflow, 2-5 files | [retrieve] build, [audit if risk is medium or higher], validate |
| 3 complex | new module, architecture, database, schema, more than 5 files | plan, [retrieve], build, audit and correct loop, validate |
| 4 critical | auth, login, password, payment, secret, token, PII, migration, production, infrastructure | level 3 plus an **approval gate** before validation |

Keyword matching uses stems (passwords, payments, migrat*, encrypt*, jwt, sessions, cookies, production, tls ...) and is strict on purpose: harmless text such as "design tokens" or "cookie banner" also classifies as level 4, because a false level 4 only costs a gate while a missed one skips the gate and the audit.

`--level N` may only **raise** the level (logged as a decision). A lower value is ignored and logged, because lowering would skip the gate, audit and validator. The classifier is **layered**: (1) keyword rules with stems, which now also cover personal data (email, phone, address, birthdate, dob, ssn, national id), access rights (admin, privilege, access control, passcode, pin), hashing (hash*, bcrypt, argon*) and live systems (live server/db, db upgrade, schema change, customer data, user data), all level 4; (2) a Haiku assist that is **on by default for real runs** and returns a structured classification, where the stricter of rules and Haiku wins (it can only raise level or risk, never lower them) and both answers are logged as a decision; if Haiku is unavailable or errors, the rules result is kept with the note "assist unavailable" and a level-2 task is raised to risk medium so it is audited; `--no-assist-classify` turns the assist off (logged), and mock runs use a scripted classification; (3) a task that matches no rule gets the safe default: level 2 with risk medium, so an Opus audit runs. Level 4 also covers health data (medical, patient, hipaa), pay data (salary, payroll), money movement (refund, stripe, paypal, wire transfer, bank account) and cloud write access (s3, bucket, iam, write access). Pure text, style, typo, rename and docs-wording tasks stay level 1. `--assist-classify` forces the assist even for mock runs; the stricter of rules and model wins, a model can never lower the level or risk.

## Safety model

- **No model output is ever executed.** The controller runs no shell commands from model output. The builder only writes *proposals* into `runs/<id>/proposals/`.
- **Only `apply` writes outside `runs/`**, behind an approval gate, with path-safe joins (no `..`, absolute paths, drive letters, NUL or control characters, `:`, **Windows 8.3 short names such as `GIT~1`**, device names), refusal of secret-like names and `.git/`, and symlink/junction-escape checks. Deny checks run on every segment of the `fs.realpathSync.native` result, so a link or short name cannot reach `.git/hooks`. **Mock runs are never applied.** The gate listing escapes control characters and prints a WARNING for executable-ish targets (`.git*`, `.husky/`, `.vscode/tasks.json`, CI workflows, `package.json`, `*.ps1|bat|cmd|sh`). Deletions need their own gate and are moved to `.orchestrator-trash/<runId>/` in the target, never hard-deleted.
- **Gates**: `level4`, `apply`, `delete`, `forcePartial`, `human`. The level-4 gate is required whenever risk is critical or the rules said level 4, whatever `--level` says. The `human` gate fires when the planner returns business or authorization questions; denied means the run ends BLOCKED with the questions listed in the report. Interactive TTY (type `GO`), or `--approve <kinds>` (logged), otherwise denied. A non-interactive run without approval ends `BLOCKED` at `APPROVAL_REQUIRED`.
- **Redaction** of secrets in everything sent to a model and in all logs (`src/redact.mjs`). Order matters: `Authorization: Bearer abc` loses `abc`. Covers header, JSON and YAML key/value forms (`"password": "..."`, `x-api-key:`, `client_secret:`), URL userinfo, URL query secrets and the `sk-ant-`, `github_pat_`, `gh[opusr]_`, `xox*`, `AKIA`, `AIza` and JWT formats. Normal prose ("authorization is required") is left alone.
- **Retrieval sandbox**: the controller reads files, not the model. Files must be under `--root` (checked on the native real path, so links and 8.3 names cannot escape). Denied: `.env*`, keys (`*.pem`, `*.key`, `id_rsa*`, `id_ed25519*`, `id_ecdsa*`), `.npmrc`, `.netrc`, `.git-credentials`, `.pypirc`, `.htpasswd`, `*.tfstate*`, `credentials*`, `secrets*`, databases, `.git/`, `node_modules/`, binaries. A denied path given **directly** as `--context` is refused, not skipped; `:` (NTFS streams) and short names are rejected; junction loops end. Size caps are reported, never silently truncated.
- **claude-cli isolation**: the child runs `claude -p --model <id> --output-format json --tools "" --strict-mcp-config --setting-sources "" --disallowedTools "mcp__*" --no-session-persistence --effort <x>` with the prompt on stdin and its cwd set to a fresh empty temp dir that is removed afterwards. No MCP servers, connectors, hooks, plugins or project settings load. Verified live: login still works with `--setting-sources ""`.
- **Independence**: auditor and validator get a fresh history with the real proposal contents, never the builder's summary. Config rejects auditor == builder model unless `allowSameModelAudit`.
- **Honest evidence**: requested vs served model per step; server fallback and model substitution are recorded and shown in the report.

## Run folder

`runs/<YYYYMMDD-HHMMSS-hex>/`: `events.jsonl` (append-only), `decisions.md`, `changelog.md`, `run.json`, `handoffs/NN-role.json`, `proposals/round-N/{manifest.json,files/...}`. `runs/` is git-ignored.

## Limits (read these)

- An automated model review is **not** a penetration test or a human security review. Level 4 work still needs a human.
- Cost uses your price table and the tokens of the model that ran each iteration (`usage.iterations`). An unknown price shows `priceKnown:false` in the report and BLOCKS when a budget is set. The budget is checked before every paid attempt (retry, fallback model). `claude-cli` cost is the cost the CLI reports (labelled) or `subscription — not metered`. The shape of `usage.iterations` (model plus token fields) is assumed from the documented fallback fields and was not seen live; entries without those fields fall back to the totals.
- A refused attempt that is retried on a fallback model loses the tokens of the refused attempt in the ledger (the SDK error carries no usage).
- The proposed code is **not executed or tested** by the controller. Run your own tests after `apply`.
- `claude-cli` provider: `claude -p` can be slow to start (11-35 s). The served model is the `modelUsage` key that matches the requested model; several keys with no match, or none, is recorded as `unverified` and listed under Not verified. If a future CLI stops authenticating with `--setting-sources ""`, switch the provider option `settingSources` to `user` and treat user hooks as a limitation.
- The `ant` profile check is a heuristic (looks for `~/.config/anthropic`); `doctor --probe` is the real test.
- Live API behaviour is covered only through a fake client in tests; run `doctor --probe` and a small real task before trusting it.

## Tests

`npm test` runs `node:test` offline (mock provider, fake Anthropic client, fake `spawn`). It covers classifier, router, state machine, hand-offs, redaction, retrieval sandbox, path safety, gates, cost, schema retry, the Anthropic provider request bodies and errors, the CLI provider, the pipeline end to end and the acceptance commands.
