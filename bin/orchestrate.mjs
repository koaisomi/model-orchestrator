#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";
import { loadConfig, ConfigError, PROJECT_ROOT, ROLES } from "../src/config.mjs";
import { classify } from "../src/classify.mjs";
import { route } from "../src/router.mjs";
import { countContextFiles } from "../src/retrieve.mjs";
import { getProvider, capabilityReport } from "../src/providers/index.mjs";
import { createGates } from "../src/gates.mjs";
import { runPipeline, EXIT } from "../src/orchestrator.mjs";
import { readRun, listRuns } from "../src/ledger.mjs";
import { renderReport, buildReport } from "../src/report.mjs";
import { applyRun, printable } from "../src/apply.mjs";

const USAGE = `orchestrate <command>
  doctor [--probe]
  classify "<task>" [--context paths...] [--root dir]
  run "<task>" [--task-file f] [--context paths...] [--root dir] [--level N]
      [--provider anthropic|claude-cli|mock] [--approve kinds] [--budget-usd N]
      [--max-rounds N] [--no-assist-classify] [--dry-run]
  status <runId> | report <runId> [--json]
  apply <runId> --target <dir> [--approve apply,delete,forcePartial]
  runs
exit codes: 0 PASS, 1 FAIL, 2 BLOCKED, 3 PARTIAL, 4 usage/config error`;

const usage = (msg) => { console.error(`error: ${msg}\n\n${USAGE}`); process.exit(EXIT.USAGE); };
const runsDir = () => path.resolve(process.env.ORCH_RUNS_DIR ?? path.join(PROJECT_ROOT, "runs"));
const csv = (s) => (s ? s.split(",").map((x) => x.trim()).filter(Boolean) : []);

let args;
try {
  args = parseArgs({
    allowPositionals: true,
    options: {
      probe: { type: "boolean" }, json: { type: "boolean" }, "dry-run": { type: "boolean" }, "assist-classify": { type: "boolean" }, "no-assist-classify": { type: "boolean" },
      context: { type: "string", multiple: true }, root: { type: "string" }, level: { type: "string" }, provider: { type: "string" },
      approve: { type: "string" }, "budget-usd": { type: "string" }, "max-rounds": { type: "string" }, "task-file": { type: "string" },
      target: { type: "string" }, help: { type: "boolean", short: "h" },
    },
  });
} catch (e) { usage(e.message); }
const { values: v, positionals: pos } = args;
const cmd = pos[0];
if (!cmd || v.help) { console.log(USAGE); process.exit(cmd ? 0 : EXIT.USAGE); }

const intOpt = (name) => {
  if (v[name] == null) return null;
  const n = Number(v[name]);
  if (!Number.isInteger(n) || n < 0) usage(`--${name} must be a non-negative integer`);
  return n;
};
const contextPaths = () => (v.context ?? []).flatMap(csv);

let config;
try {
  const budget = v["budget-usd"] != null ? Number(v["budget-usd"]) : null;
  if (budget != null && !(budget > 0)) usage("--budget-usd must be a number > 0");
  config = loadConfig({ overrides: { budgetUsd: budget } });
} catch (e) {
  if (e instanceof ConfigError) { console.error(e.message); process.exit(EXIT.USAGE); }
  throw e;
}

function taskText() {
  if (v["task-file"]) {
    try { return fs.readFileSync(v["task-file"], "utf8").trim(); } catch (e) { usage(`cannot read --task-file: ${e.message}`); }
  }
  if (!pos[1]) usage("missing task text");
  return pos[1];
}

async function main() {
  switch (cmd) {
    case "doctor": {
      console.log(`Node ${process.version} (need >= 22): ${Number(process.versions.node.split(".")[0]) >= 22 ? "OK" : "TOO OLD"}`);
      console.log("Config: OK (orchestrator.config.json valid, independence rule satisfied)");
      for (const r of ROLES) { const s = config.roles[r]; console.log(`  ${r.padEnd(9)} ${s.model}  effort=${s.effort}${s.fallbackModel ? `  fallback=${s.fallbackModel}` : ""}`); }
      const caps = await capabilityReport(config);
      console.log("Providers:");
      for (const [n, c] of Object.entries(caps)) console.log(`  ${n.padEnd(11)} ${c.available ? "AVAILABLE" : "BLOCKED"}: ${c.reason}`);
      const def = config.provider;
      console.log(`Default provider "${def}": ${caps[def]?.available ? "AVAILABLE" : "BLOCKED (real runs will end BLOCKED; use --dry-run for a labelled mock run)"}`);
      if (v.probe) {
        if (caps.anthropic.available) {
          const p = await getProvider("anthropic", { config }).probe([...new Set(ROLES.flatMap((r) => [config.roles[r].model, config.roles[r].fallbackModel].filter(Boolean)))]);
          for (const [m, r] of Object.entries(p)) console.log(`  anthropic probe ${m}: ${r.usable ? "usable" : "NOT usable (" + r.reason + ")"}`);
        } else console.log("Anthropic probe skipped: provider is BLOCKED (no credentials).");
        if (caps["claude-cli"].available) {
          const model = config.roles.retriever.model; // haiku only, one short prompt
          try {
            const r = await getProvider("claude-cli", { config }).probe(model);
            console.log(`  claude-cli probe: AUTH OK with isolation flags; requested ${model}; servedModel ${r.servedModel}${r.note ? ` (${r.note})` : ""}; reply "${r.text}"; ${r.reportedUsd != null ? "reported cost $" + r.reportedUsd : "subscription - not metered"}`);
          } catch (e) { console.log(`  claude-cli probe: FAILED: ${e.message}`); }
        } else console.log("claude-cli probe skipped: binary not found.");
      }
      return 0;
    }
    case "classify": {
      const root = path.resolve(v.root ?? process.cwd());
      const c = classify(taskText(), { contextFileCount: countContextFiles(contextPaths(), root), levelOverride: intOpt("level") });
      console.log(JSON.stringify({ ...c, route: route(c.level, { hasContext: contextPaths().length > 0, risk: c.risk }) }, null, 2));
      return 0;
    }
    case "run": {
      const task = taskText();
      const dry = !!v["dry-run"];
      const name = dry ? "mock" : (v.provider ?? config.provider);
      let gates, provider;
      try { gates = createGates({ approve: csv(v.approve) }); provider = getProvider(name, { config }); }
      catch (e) { usage(e.message); }
      let context = contextPaths();
      let contextExplicit = true;
      if (!context.length && v.root) { context = ["."]; contextExplicit = false; }
      if (name === "mock") console.log("MOCK RUN — no model was called\n");
      const run = await runPipeline({
        task, provider, config, gates, runsDir: runsDir(), root: path.resolve(v.root ?? process.cwd()), context, contextExplicit,
        levelOverride: intOpt("level"), assistClassify: v["no-assist-classify"] ? false : v["assist-classify"] ? true : undefined, dryRun: dry, maxRounds: intOpt("max-rounds") ?? undefined,
        budgetUsd: v["budget-usd"] != null ? Number(v["budget-usd"]) : undefined, log: (s) => console.log(s),
      });
      console.log("\n" + renderReport(run));
      console.log(`\nRun folder: ${path.join(runsDir(), run.runId)}`);
      return run.exitCode;
    }
    case "status": {
      if (!pos[1]) usage("missing runId");
      const r = readRun(runsDir(), pos[1]);
      console.log(`${r.runId}  ${r.status}  state=${r.state}  level=${r.classification?.level}  provider=${r.provider}${r.mock ? " (MOCK)" : ""}${r.blockReason ? `\nreason: ${r.blockReason}` : ""}`);
      return 0;
    }
    case "report": {
      if (!pos[1]) usage("missing runId");
      const r = readRun(runsDir(), pos[1]);
      console.log(v.json ? JSON.stringify(buildReport(r), null, 2) : renderReport(r));
      return 0;
    }
    case "runs": {
      const l = listRuns(runsDir());
      if (!l.length) console.log("no runs yet");
      for (const r of l) console.log(`${r.runId}  ${String(r.status).padEnd(8)} L${r.level ?? "?"}  ${r.task.slice(0, 70)}`);
      return 0;
    }
    case "apply": {
      if (!pos[1]) usage("missing runId");
      if (!v.target) usage("apply needs --target <dir>");
      let gates;
      try { gates = createGates({ approve: csv(v.approve) }); } catch (e) { usage(e.message); }
      try {
        const res = await applyRun({ runsDir: runsDir(), runId: pos[1], target: path.resolve(v.target), gates, log: (s) => console.log(s) });
        const P = printable;
        console.log(`written: ${res.written.map(P).join(", ") || "none"}\ntrashed: ${res.trashed.map(P).join(", ") || "none"}\nskipped: ${res.skipped.map((s) => `${P(s.path)} (${s.reason})`).join(", ") || "none"}`);
        return 0;
      } catch (e) {
        console.error(`apply refused: ${printable(e.message)}`);
        return EXIT.BLOCKED;
      }
    }
    default: usage(`unknown command "${cmd}"`);
  }
}

main().then((code) => process.exit(code ?? 0), (e) => { console.error(`fatal: ${e.message}`); process.exit(1); });
