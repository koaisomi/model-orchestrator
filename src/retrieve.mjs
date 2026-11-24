import fs from "node:fs";
import path from "node:path";
import { redact } from "./redact.mjs";
import { isInside, isDeniedName, isDeniedDir, isDeniedPath, hasShortName } from "./paths.mjs";

export const CAPS = { perFile: 200 * 1024, total: 2 * 1024 * 1024, files: 200 };

export class RetrieveError extends Error {}

const key = (p) => (process.platform === "win32" ? p.toLowerCase() : p);

/**
 * Controller-side safe file reader. Model never reads disk. Overflow is reported in `skipped`, never truncated.
 * All checks run on the fs.realpathSync.native result, so 8.3 short names and links cannot dodge the deny list.
 * @param {string[]} paths files or dirs under root
 * @param {{root:string, caps?:typeof CAPS}} o
 * @returns {{files:{path:string,content:string,bytes:number}[], skipped:{path:string,reason:string}[], totalBytes:number}}
 */
export function retrieve(paths, { root, caps = CAPS }) {
  const realRoot = fs.realpathSync.native(root);
  const files = [], skipped = [];
  const visited = new Set(); // junction/symlink loop guard
  let total = 0;
  const rel = (p) => path.relative(realRoot, p).split(path.sep).join("/") || ".";

  function addFile(real) {
    const r = rel(real);
    if (isDeniedPath(r)) return skipped.push({ path: r, reason: "denied (secret-like file name)" });
    let st;
    try { st = fs.statSync(real); } catch (e) { return skipped.push({ path: r, reason: `unreadable: ${e.code ?? e.message}` }); }
    if (!st.isFile()) return skipped.push({ path: r, reason: "not a regular file" });
    if (files.length >= caps.files) return skipped.push({ path: r, reason: `file cap ${caps.files} reached` });
    if (st.size > caps.perFile) return skipped.push({ path: r, reason: `too large (${st.size} B > ${caps.perFile} B)` });
    if (total + st.size > caps.total) return skipped.push({ path: r, reason: `total cap ${caps.total} B reached` });
    const buf = fs.readFileSync(real);
    if (buf.subarray(0, 8192).includes(0)) return skipped.push({ path: r, reason: "binary (NUL byte)" });
    total += st.size;
    files.push({ path: r, content: redact(buf.toString("utf8")), bytes: st.size });
  }

  function walk(dir) {
    if (visited.has(key(dir))) return;
    visited.add(key(dir));
    const entries = fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name));
    for (const e of entries) {
      const full = path.join(dir, e.name);
      if (e.isDirectory() && isDeniedDir(e.name)) { skipped.push({ path: rel(full) + "/", reason: "denied directory" }); continue; }
      let real;
      try { real = fs.realpathSync.native(full); } catch { skipped.push({ path: rel(full), reason: "unresolvable" }); continue; }
      if (!isInside(realRoot, real)) { skipped.push({ path: rel(full), reason: "symlink escapes root" }); continue; }
      if (isDeniedPath(rel(real))) { skipped.push({ path: rel(full), reason: "denied (resolves to a protected path)" }); continue; }
      const st = fs.statSync(real);
      if (st.isDirectory()) walk(real); else addFile(real);
    }
  }

  for (const p of paths) {
    if (typeof p !== "string" || !p || p.includes("\0")) throw new RetrieveError("invalid context path");
    if (hasShortName(p)) throw new RetrieveError(`context path with 8.3 short name rejected: ${p}`);
    if (p.replace(/^[a-zA-Z]:[\\/]/, "").includes(":")) throw new RetrieveError(`context path with ":" rejected (NTFS stream): ${p}`);
    const abs = path.resolve(realRoot, p);
    let real;
    try { real = fs.realpathSync.native(abs); } catch { throw new RetrieveError(`context path not found: ${p}`); }
    if (!isInside(realRoot, real)) throw new RetrieveError(`context path outside root rejected: ${p}`);
    if (isDeniedPath(rel(real)) || isDeniedPath(p)) throw new RetrieveError(`context path is protected and refused: ${p}`);
    if (fs.statSync(real).isDirectory()) walk(real); else addFile(real);
  }
  return { files, skipped, totalBytes: total };
}

/** Cheap pre-count for classification (same denies, no extra reads kept). */
export function countContextFiles(paths, root) {
  try { return retrieve(paths, { root }).files.length; } catch { return 0; }
}

export { isDeniedName };
