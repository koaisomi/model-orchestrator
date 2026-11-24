import fs from "node:fs";
import path from "node:path";
import { runDir, readRun } from "./ledger.mjs";
import { safeJoin, isInside, realpathLoose, isDeniedPath } from "./paths.mjs";

export class ApplyError extends Error {}

/** Escape control characters so a hostile file name cannot forge terminal output or log lines. */
export const printable = (s) => String(s).replace(/\p{Cc}/gu, (c) => `\\x${c.charCodeAt(0).toString(16).padStart(2, "0")}`);

/** Paths that can run code later (hooks, tasks, scripts, CI). Returns a warning string or null. */
export function executableWarning(rel) {
  const p = rel.replace(/\\/g, "/").toLowerCase();
  const base = p.split("/").pop();
  if (p.split("/").some((s) => s.startsWith(".git"))) return "git metadata or hooks (.git*)";
  if (p.startsWith(".husky/") || p.includes("/.husky/")) return "husky git hooks";
  if (p.endsWith(".vscode/tasks.json") || p.endsWith(".vscode/settings.json") || p.endsWith(".vscode/launch.json")) return "editor tasks that can run commands";
  if (p.startsWith(".github/workflows/")) return "CI workflow";
  if (base === "package.json") return "package.json (scripts may change and run on install or test)";
  if (/\.(ps1|bat|cmd|sh)$/.test(base)) return "shell script";
  return null;
}

/**
 * Apply the final builder proposal of a finished run into `target`. The ONLY code path that writes outside runs/.
 * Needs status PASS (or PARTIAL + forcePartial gate), an `apply` gate, and a separate `delete` gate for deletions.
 * MOCK runs are refused. Deletions are moved to <target>/.orchestrator-trash/<runId>/ (never hard-deleted).
 * Nothing from the proposal is ever executed.
 * @param {{runsDir:string, runId:string, target:string, gates:{request:Function}, log?:(s:string)=>void}} o
 */
export async function applyRun({ runsDir, runId, target, gates, log = () => {} }) {
  const run = readRun(runsDir, runId);
  if (run.mock) throw new ApplyError("this run used the mock provider: its output is scripted, not model-produced, and is never applied");
  if (run.status !== "PASS" && run.status !== "PARTIAL") throw new ApplyError(`run status is ${run.status}; only PASS (or PARTIAL with forcePartial) can be applied`);
  if (!run.finalRound) throw new ApplyError("run has no proposal");
  if (!fs.existsSync(target) || !fs.statSync(target).isDirectory()) throw new ApplyError(`target directory not found: ${target}`);
  const realTarget = fs.realpathSync.native(target);

  const base = path.join(runDir(runsDir, runId), "proposals", `round-${run.finalRound}`);
  const manifest = JSON.parse(fs.readFileSync(path.join(base, "manifest.json"), "utf8"));
  const filesDir = path.join(base, "files");

  // validate every path before touching anything; deny checks run on the NATIVE real path too (8.3 names, links)
  const plan = manifest.files.map((f) => {
    if (isDeniedPath(f.path)) throw new ApplyError(`refusing to touch protected path: ${printable(f.path)}`);
    const dest = safeJoin(realTarget, f.path);
    const realDest = realpathLoose(dest);
    if (!isInside(realTarget, realDest)) throw new ApplyError(`path escapes target through a link: ${printable(f.path)}`);
    if (isDeniedPath(path.relative(realTarget, realDest))) throw new ApplyError(`refusing to touch protected path (resolves to ${printable(path.relative(realTarget, realDest))})`);
    return { ...f, dest, warning: executableWarning(f.path) };
  });

  log(`Run ${runId} (${run.status}) proposes ${plan.length} file(s) for ${realTarget}:`);
  for (const f of plan) log(`  ${f.action.padEnd(7)} ${printable(f.path)}`);
  const warnings = plan.filter((f) => f.warning);
  for (const f of warnings) log(`  WARNING: ${printable(f.path)} is executable-ish: ${f.warning}`);
  const warnText = warnings.length ? `\nWARNING executable-ish targets: ${warnings.map((f) => printable(f.path)).join(", ")}` : "";

  const approvals = [];
  if (run.status === "PARTIAL") {
    const g = await gates.request("forcePartial", `Run ${runId} is PARTIAL (not fully verified). Apply anyway?`);
    approvals.push(g);
    if (!g.approved) throw new ApplyError(`forcePartial gate ${g.mode}`);
  }
  const g = await gates.request("apply", `Write ${plan.filter((f) => f.action !== "delete").length} file(s) into ${realTarget}${warnText}`);
  approvals.push(g);
  if (!g.approved) throw new ApplyError(`apply gate ${g.mode}`);
  const hasDelete = plan.some((f) => f.action === "delete");
  let deleteOk = false;
  if (hasDelete) {
    const d = await gates.request("delete", `Move ${plan.filter((f) => f.action === "delete").length} file(s) to .orchestrator-trash`);
    approvals.push(d);
    deleteOk = d.approved;
  }

  const res = { written: [], trashed: [], skipped: [], approvals, warnings: warnings.map((f) => f.path) };
  for (const f of plan) {
    if (f.action === "delete") {
      if (!deleteOk) { res.skipped.push({ path: f.path, reason: "delete gate not approved" }); continue; }
      if (!fs.existsSync(f.dest)) { res.skipped.push({ path: f.path, reason: "does not exist" }); continue; }
      const trash = safeJoin(path.join(realTarget, ".orchestrator-trash", runId), f.path);
      // a pre-existing junction at .orchestrator-trash must not carry files out of the target
      if (!isInside(realTarget, realpathLoose(path.dirname(trash)))) { res.skipped.push({ path: f.path, reason: "trash folder escapes target" }); continue; }
      fs.mkdirSync(path.dirname(trash), { recursive: true });
      fs.renameSync(f.dest, trash);
      res.trashed.push(f.path);
      continue;
    }
    if (f.action === "create" && fs.existsSync(f.dest)) { res.skipped.push({ path: f.path, reason: "create but file already exists" }); continue; }
    if (f.action === "replace" && !fs.existsSync(f.dest)) { res.skipped.push({ path: f.path, reason: "replace but file does not exist" }); continue; }
    const src = safeJoin(filesDir, f.path);
    // resolve the parent BEFORE creating anything, so a link cannot make mkdir build directories outside the target
    if (!isInside(realTarget, realpathLoose(path.dirname(f.dest)))) { res.skipped.push({ path: f.path, reason: "parent escapes target" }); continue; }
    fs.mkdirSync(path.dirname(f.dest), { recursive: true });
    fs.writeFileSync(f.dest, fs.readFileSync(src));
    res.written.push(f.path);
  }
  fs.appendFileSync(path.join(runDir(runsDir, runId), "events.jsonl"), JSON.stringify({ ts: new Date().toISOString(), type: "apply", target: realTarget, written: res.written, trashed: res.trashed, skipped: res.skipped, approvals }) + "\n");
  return res;
}
