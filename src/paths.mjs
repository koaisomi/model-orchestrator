import fs from "node:fs";
import path from "node:path";

const WIN = process.platform === "win32";
const norm = (p) => (WIN ? p.toLowerCase() : p);

/** True when `child` is `base` or inside it. Case-insensitive on win32. Both must be absolute. */
export function isInside(base, child) {
  const rel = path.relative(norm(path.resolve(base)), norm(path.resolve(child)));
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

/**
 * realpath that works for a path that does not exist yet: resolves the deepest existing ancestor.
 * Uses realpathSync.native so Windows 8.3 short names (GIT~1) are expanded to the real name.
 */
export function realpathLoose(p) {
  const abs = path.resolve(p);
  const tail = [];
  let cur = abs;
  while (!fs.existsSync(cur)) {
    const up = path.dirname(cur);
    if (up === cur) break;
    tail.unshift(path.basename(cur));
    cur = up;
  }
  return path.join(fs.realpathSync.native(cur), ...tail);
}

const RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\..*)?$/i;

/** True when any segment looks like an NTFS 8.3 short name (GIT~1, PROGRA~1). JS realpath does not expand these. */
export function hasShortName(p) {
  return String(p).split(/[\\/]+/).some((seg) => /~\d/.test(seg));
}

/**
 * Join a model-supplied relative path onto base. Throws on anything unsafe:
 * NUL/control chars, absolute, drive letter, "..", ":" (NTFS streams), 8.3 short names,
 * reserved device names, trailing dot/space.
 */
export function safeJoin(base, rel) {
  if (typeof rel !== "string" || rel.length === 0) throw new Error("unsafe path: empty");
  if (rel.includes("\0")) throw new Error("unsafe path: NUL byte");
  if (/\p{Cc}/u.test(rel)) throw new Error("unsafe path: control character");
  if (/^[a-zA-Z]:/.test(rel)) throw new Error(`unsafe path: drive letter (${rel})`);
  if (rel.startsWith("/") || rel.startsWith("\\") || path.isAbsolute(rel)) throw new Error(`unsafe path: absolute (${rel})`);
  const parts = rel.split(/[\\/]+/).filter((x) => x !== "" && x !== ".");
  if (parts.length === 0) throw new Error("unsafe path: empty");
  for (const seg of parts) {
    if (seg === "..") throw new Error(`unsafe path: parent segment (${rel})`);
    if (seg.includes(":")) throw new Error(`unsafe path: colon in segment (${rel})`);
    if (/~\d/.test(seg)) throw new Error(`unsafe path: 8.3 short-name segment (${rel})`);
    if (RESERVED.test(seg)) throw new Error(`unsafe path: reserved device name (${rel})`);
    if (/[. ]$/.test(seg)) throw new Error(`unsafe path: trailing dot or space (${rel})`);
  }
  const out = path.resolve(base, ...parts);
  if (!isInside(base, out)) throw new Error(`unsafe path: escapes base (${rel})`);
  return out;
}

const DENY_NAMES = [
  /^\.env/i, /\.pem$/i, /\.key$/i, /^id_rsa/i, /^id_ed25519/i, /^id_ecdsa/i, /\.p12$/i, /\.pfx$/i,
  /^credentials/i, /^secrets/i, /\.sqlite3?$/i, /^\.npmrc$/i, /^[._]netrc$/i, /^\.git-credentials$/i,
  /^\.pypirc$/i, /\.tfstate/i, /^\.htpasswd$/i,
];
const DENY_DIRS = new Set([".git", "node_modules"]);

// Windows ignores trailing dots/spaces and NTFS stream suffixes, so the deny list must too.
const clean = (name) => name.split(":")[0].replace(/[. ]+$/, "");

/** True when a file name (basename) must never be read or written by the controller. */
export function isDeniedName(name) {
  const n = clean(name);
  return DENY_NAMES.some((re) => re.test(n));
}
export function isDeniedDir(name) {
  return DENY_DIRS.has(clean(name).toLowerCase());
}
/** True when any segment of a relative path is denied (dirs on every segment, names on every segment too). */
export function isDeniedPath(rel) {
  const parts = rel.split(/[\\/]+/).filter((x) => x && x !== ".");
  return parts.some((p, i) => isDeniedDir(p) || (i === parts.length - 1 && isDeniedName(p)));
}
