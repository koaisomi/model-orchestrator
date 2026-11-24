import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { redactDeep } from "./redact.mjs";
import { safeJoin } from "./paths.mjs";

export const RUN_ID_RE = /^\d{8}-\d{6}-[0-9a-f]{6}$/;

export function newRunId(now = new Date()) {
  const p = (n, l = 2) => String(n).padStart(l, "0");
  const d = `${now.getFullYear()}${p(now.getMonth() + 1)}${p(now.getDate())}-${p(now.getHours())}${p(now.getMinutes())}${p(now.getSeconds())}`;
  return `${d}-${crypto.randomBytes(3).toString("hex")}`;
}

export function runDir(runsDir, runId) {
  if (!RUN_ID_RE.test(runId)) throw new Error(`invalid run id "${runId}"`);
  return path.join(runsDir, runId);
}

/** Run folder writer. Everything it writes stays under runs/<id>/. events.jsonl is append-only and redacted. */
export function createLedger(runsDir, runId) {
  const dir = runDir(runsDir, runId);
  fs.mkdirSync(path.join(dir, "handoffs"), { recursive: true });
  fs.mkdirSync(path.join(dir, "proposals"), { recursive: true });
  const w = (f, s) => fs.appendFileSync(path.join(dir, f), s);
  return {
    dir,
    event(type, data = {}) {
      w("events.jsonl", JSON.stringify(redactDeep({ ts: new Date().toISOString(), type, ...data })) + "\n");
    },
    decision(text) { w("decisions.md", `- ${new Date().toISOString()} ${redactDeep(text)}\n`); },
    change(text) { w("changelog.md", `- ${new Date().toISOString()} ${redactDeep(text)}\n`); },
    saveHandoff(n, role, handoff) {
      fs.writeFileSync(path.join(dir, "handoffs", `${String(n).padStart(2, "0")}-${role}.json`), JSON.stringify(redactDeep(handoff), null, 2));
    },
    /** Write builder files under proposals/round-N/files/<path> plus manifest.json. Content is kept verbatim (it is code for review). */
    saveProposal(round, build) {
      const base = path.join(dir, "proposals", `round-${round}`);
      const filesDir = path.join(base, "files");
      fs.mkdirSync(filesDir, { recursive: true });
      const manifest = { summary: build.summary, files: [], testsSuggested: build.testsSuggested, limitations: build.limitations };
      for (const f of build.files) {
        const target = safeJoin(filesDir, f.path); // throws on unsafe path
        manifest.files.push({ path: f.path, action: f.action, bytes: f.action === "delete" ? 0 : Buffer.byteLength(f.content) });
        if (f.action === "delete") continue;
        fs.mkdirSync(path.dirname(target), { recursive: true });
        fs.writeFileSync(target, f.content);
      }
      fs.writeFileSync(path.join(base, "manifest.json"), JSON.stringify(manifest, null, 2));
      return base;
    },
    saveRun(run) { fs.writeFileSync(path.join(dir, "run.json"), JSON.stringify(redactDeep(run), null, 2)); },
  };
}

export function readRun(runsDir, runId) {
  const f = path.join(runDir(runsDir, runId), "run.json");
  if (!fs.existsSync(f)) throw new Error(`run ${runId} not found (no run.json)`);
  return JSON.parse(fs.readFileSync(f, "utf8"));
}

export function listRuns(runsDir) {
  if (!fs.existsSync(runsDir)) return [];
  return fs.readdirSync(runsDir).filter((n) => RUN_ID_RE.test(n)).sort().map((id) => {
    try { const r = readRun(runsDir, id); return { runId: id, status: r.status, level: r.classification?.level, task: r.task }; }
    catch { return { runId: id, status: "UNKNOWN", level: null, task: "" }; }
  });
}
