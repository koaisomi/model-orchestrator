import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { redact, redactDeep } from "../src/redact.mjs";
import { retrieve, RetrieveError } from "../src/retrieve.mjs";
import { safeJoin, isDeniedPath, isInside } from "../src/paths.mjs";
import { validateBuildPaths } from "../src/schemas.mjs";
import { createLedger, newRunId, runDir, RUN_ID_RE } from "../src/ledger.mjs";
import { applyRun, ApplyError } from "../src/apply.mjs";
import { createGates } from "../src/gates.mjs";

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "orch-"));

test("redact: header-with-scheme loses the token (two-pass order)", () => {
  assert.equal(redact("Authorization: Bearer abc"), "Authorization: [REDACTED]");
  assert.ok(!redact("Authorization: Basic dXNlcjpwYXNz").includes("dXNlcjpwYXNz"));
  assert.ok(!redact("authorization=token ghs123").includes("ghs123"));
  assert.equal(redact("curl -H 'x' Bearer zzz999"), "curl -H 'x' Bearer [REDACTED]");
});

test("redact: mixed sample, every secret kind gone, normal text kept", () => {
  const sample = [
    "Authorization: Bearer abc",
    "key sk-ant-api03-AAAAAAAAAAAAAAAA and sk-1234567890abcdefghijXYZ",
    "gh ghp_abcDEF123 slack xoxb-111-222-abc",
    "aws AKIAABCDEFGHIJKLMNOP",
    "-----BEGIN RSA PRIVATE KEY-----\nMIIEvQ\nline2\n-----END RSA PRIVATE KEY-----",
    "password: hunter2 and PASSWORD=Sup3r",
    "https://x.test/cb?token=tok123&ok=1&api_key=k456&secret=s789",
    "plain text stays",
  ].join("\n");
  const out = redact(sample);
  for (const leak of ["abc", "sk-ant-api03", "1234567890abcdefghij", "ghp_abc", "xoxb-111", "AKIAABCDEFGHIJKLMNOP", "MIIEvQ", "hunter2", "Sup3r", "tok123", "k456", "s789"]) {
    assert.ok(!out.includes(leak), `leaked ${leak}`);
  }
  assert.ok(out.includes("plain text stays"));
  assert.ok(out.includes("ok=1"));
  console.log("--- redact() sample output ---\n" + out + "\n--- end ---");
});

test("redactDeep walks objects and arrays", () => {
  const o = redactDeep({ a: ["Bearer xyz987"], b: { c: "password=pw1" }, n: 5 });
  assert.equal(o.n, 5);
  assert.ok(!JSON.stringify(o).includes("xyz987") && !JSON.stringify(o).includes("pw1"));
});

test("safeJoin / proposal path safety", () => {
  const base = path.resolve(tmp());
  assert.equal(safeJoin(base, "a/b.txt"), path.join(base, "a", "b.txt"));
  assert.equal(safeJoin(base, "a\\b.txt"), path.join(base, "a", "b.txt"));
  for (const bad of ["../x", "a/../../x", "/etc/passwd", "\\win", "C:\\Windows\\x", "c:/x", "a\0b", "", "a/b:stream", "con", "NUL.txt", "dir/x.", "..\\x"]) {
    assert.throws(() => safeJoin(base, bad), /unsafe path/, `accepted ${JSON.stringify(bad)}`);
  }
  assert.deepEqual(validateBuildPaths({ files: [{ path: "ok.txt" }, { path: "../no" }, { path: "OK.txt" }] }).length, 2);
});

test("denied paths", () => {
  for (const p of [".env", "cfg/.env.local", "a/id_rsa", "k.pem", "x.key", "credentials.json", "secrets.yaml", ".git/config", "node_modules/x/y.js", "db.sqlite"]) assert.ok(isDeniedPath(p), p);
  assert.ok(!isDeniedPath("src/app.js"));
  assert.ok(isInside("C:\\A", "c:\\a\\b") === (process.platform === "win32"));
});

function fixture() {
  const root = tmp();
  fs.mkdirSync(path.join(root, "src"));
  fs.mkdirSync(path.join(root, "node_modules"));
  fs.mkdirSync(path.join(root, ".git"));
  fs.writeFileSync(path.join(root, "README.md"), "hello Authorization: Bearer sekret1\n");
  fs.writeFileSync(path.join(root, "src", "a.js"), "export const a = 1;\n");
  fs.writeFileSync(path.join(root, ".env"), "KEY=zzz\n");
  fs.writeFileSync(path.join(root, "server.pem"), "x");
  fs.writeFileSync(path.join(root, "node_modules", "m.js"), "x");
  fs.writeFileSync(path.join(root, ".git", "HEAD"), "x");
  fs.writeFileSync(path.join(root, "bin.dat"), Buffer.from([1, 2, 0, 3]));
  return root;
}

test("retrieve: deny list, binary skip, redaction, reported skips", () => {
  const root = fixture();
  const r = retrieve(["."], { root });
  const names = r.files.map((f) => f.path).sort();
  assert.deepEqual(names, ["README.md", "src/a.js"]);
  assert.ok(!r.files.find((f) => f.path === "README.md").content.includes("sekret1"));
  const why = Object.fromEntries(r.skipped.map((s) => [s.path, s.reason]));
  assert.match(why[".env"], /denied/);
  assert.match(why["server.pem"], /denied/);
  assert.match(why["bin.dat"], /binary/);
  assert.match(why["node_modules/"], /denied directory/);
  assert.match(why[".git/"], /denied directory/);
});

test("retrieve: outside root rejected (.. and absolute), missing path rejected", () => {
  const root = fixture();
  const other = tmp();
  fs.writeFileSync(path.join(other, "x.txt"), "x");
  assert.throws(() => retrieve(["../" + path.basename(other)], { root }), RetrieveError);
  assert.throws(() => retrieve([path.join(other, "x.txt")], { root }), /outside root/);
  assert.throws(() => retrieve(["nope.txt"], { root }), /not found/);
});

test("retrieve: symlink escape (skipped if symlinks unsupported)", (t) => {
  const root = fixture();
  const other = tmp();
  fs.writeFileSync(path.join(other, "leak.txt"), "leak");
  try { fs.symlinkSync(other, path.join(root, "link"), "junction"); } catch { return t.skip("symlink not permitted"); }
  const r = retrieve(["."], { root });
  assert.ok(!r.files.some((f) => f.content === "leak"));
  assert.ok(r.skipped.some((s) => s.path === "link" && /escapes/.test(s.reason)));
  assert.throws(() => retrieve(["link/leak.txt"], { root }), /outside root/);
});

test("retrieve: caps are reported, never silently truncated", () => {
  const root = tmp();
  for (let i = 0; i < 5; i++) fs.writeFileSync(path.join(root, `f${i}.txt`), "x".repeat(100));
  fs.writeFileSync(path.join(root, "big.txt"), "y".repeat(500));
  const r = retrieve(["."], { root, caps: { perFile: 300, total: 250, files: 3 } });
  const why = Object.fromEntries(r.skipped.map((s) => [s.path, s.reason]));
  assert.match(why["big.txt"], /too large/);
  assert.equal(r.files.length, 2); // total cap 250 B stops at 2 x 100
  assert.ok(r.skipped.length >= 4);
  assert.ok(r.files.every((f) => f.content.length === 100)); // none truncated
});

test("ledger: run id format, traversal rejected, events redacted", () => {
  assert.match(newRunId(), RUN_ID_RE);
  const runs = tmp();
  assert.throws(() => runDir(runs, "../evil"));
  const id = newRunId();
  const l = createLedger(runs, id);
  l.event("x", { text: "Authorization: Bearer leak1" });
  const ev = fs.readFileSync(path.join(l.dir, "events.jsonl"), "utf8");
  assert.ok(!ev.includes("leak1"));
  assert.throws(() => l.saveProposal(1, { summary: "", files: [{ path: "../escape.txt", action: "create", content: "x" }], testsSuggested: [], limitations: [] }), /unsafe/);
  assert.ok(!fs.existsSync(path.join(l.dir, "proposals", "escape.txt")));
});

function finishedRun(files, status = "PASS") {
  const runs = tmp();
  const id = newRunId();
  const l = createLedger(runs, id);
  l.saveProposal(1, { summary: "s", files, testsSuggested: [], limitations: [] });
  l.saveRun({ runId: id, status, finalRound: 1, classification: { level: 1 } });
  return { runs, id };
}

test("apply: needs PASS, writes only after gate, path-safe, protected paths refused", async () => {
  const target = tmp();
  fs.writeFileSync(path.join(target, "old.txt"), "old");
  const { runs, id } = finishedRun([
    { path: "new/a.txt", action: "create", content: "A" },
    { path: "old.txt", action: "replace", content: "NEW" },
  ]);
  const denied = createGates({ isTTY: false });
  await assert.rejects(applyRun({ runsDir: runs, runId: id, target, gates: denied }), /apply gate denied/);
  assert.equal(fs.readFileSync(path.join(target, "old.txt"), "utf8"), "old");
  assert.ok(!fs.existsSync(path.join(target, "new")));
  const ok = createGates({ isTTY: false, approve: ["apply"] });
  const res = await applyRun({ runsDir: runs, runId: id, target, gates: ok });
  assert.deepEqual(res.written.sort(), ["new/a.txt", "old.txt"]);
  assert.equal(fs.readFileSync(path.join(target, "old.txt"), "utf8"), "NEW");

  const bad = finishedRun([{ path: ".env", action: "create", content: "K=1" }]);
  await assert.rejects(applyRun({ runsDir: bad.runs, runId: bad.id, target, gates: ok }), /protected/);
  const fail = finishedRun([{ path: "a.txt", action: "create", content: "x" }], "FAIL");
  await assert.rejects(applyRun({ runsDir: fail.runs, runId: fail.id, target, gates: ok }), ApplyError);
  const part = finishedRun([{ path: "p.txt", action: "create", content: "x" }], "PARTIAL");
  await assert.rejects(applyRun({ runsDir: part.runs, runId: part.id, target, gates: ok }), /forcePartial/);
  await applyRun({ runsDir: part.runs, runId: part.id, target, gates: createGates({ isTTY: false, approve: ["apply", "forcePartial"] }) });
  assert.ok(fs.existsSync(path.join(target, "p.txt")));
});

test("apply: delete needs its own gate and moves to trash (no hard delete)", async () => {
  const target = tmp();
  fs.writeFileSync(path.join(target, "gone.txt"), "bye");
  const { runs, id } = finishedRun([{ path: "gone.txt", action: "delete", content: "" }]);
  const r1 = await applyRun({ runsDir: runs, runId: id, target, gates: createGates({ isTTY: false, approve: ["apply"] }) });
  assert.equal(r1.trashed.length, 0);
  assert.ok(fs.existsSync(path.join(target, "gone.txt")));
  const r2 = await applyRun({ runsDir: runs, runId: id, target, gates: createGates({ isTTY: false, approve: ["apply", "delete"] }) });
  assert.deepEqual(r2.trashed, ["gone.txt"]);
  assert.ok(!fs.existsSync(path.join(target, "gone.txt")));
  assert.ok(fs.existsSync(path.join(target, ".orchestrator-trash", id, "gone.txt")));
});
