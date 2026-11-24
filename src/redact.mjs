/**
 * Secret redaction. ORDER MATTERS: header-with-scheme first so that
 * "Authorization: Bearer abc" loses "abc" (a bare bearer pass alone would keep it).
 * "authorization" is only redacted when followed by ":" or "=" (JSON/YAML/header), or by a known scheme,
 * so ordinary prose ("authorization is required") keeps its next word.
 * shortcut: pattern based. A secret in an unknown format can slip through; keep secrets out of context folders.
 */
const KEYWORDS = "cookie|api[_-]?key|apikey|access[_-]?key|secret[_-]?key|client[_-]?secret|private[_-]?key|token|secret|password|passwd|pwd";

const PASSES = [
  // 1. header / JSON / YAML authorization with optional scheme, quoted or not
  [/\bauthorization["']?\s*[:=]\s*["']?(?:(?:bearer|basic|token|digest|negotiate)\s+)?[^\s"',;}]+/gi, "Authorization: [REDACTED]"],
  // 1b. no separator but a known scheme
  [/\bauthorization\s+(?:bearer|basic|token|digest)\s+[^\s"',;}]+/gi, "Authorization: [REDACTED]"],
  // 1c. Cookie / Set-Cookie header: the whole line value (sid=abc123; theme=dark)
  [/\b(set-)?cookie\s*:[^\r\n]*/gi, (m, set) => `${set ? "Set-Cookie" : "Cookie"}: [REDACTED]`],
  // 2. bare bearer token
  [/\bbearer\s+[A-Za-z0-9._~+\/=-]{6,}/gi, "Bearer [REDACTED]"],
  // 3. URL userinfo  scheme://user:pw@host  and scheme://token@host
  [/\b([a-z][a-z0-9+.-]*:\/\/)[^\s\/@:"']+:[^\s\/@"']+@/gi, "$1[REDACTED]@"],
  // 4. vendor token prefixes
  [/sk-ant-[\w-]+/g, "[REDACTED:anthropic-key]"],
  [/sk-[\w-]{20,}/g, "[REDACTED:api-key]"],
  [/github_pat_\w+/g, "[REDACTED:github-token]"],
  [/gh[opusr]_\w+/g, "[REDACTED:github-token]"],
  [/xox[abprs]-[\w-]+/g, "[REDACTED:slack-token]"],
  [/\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g, "[REDACTED:aws-key-id]"],
  [/AIza[\w-]{20,}/g, "[REDACTED:google-key]"],
  [/\beyJ[\w-]{8,}\.[\w-]{8,}\.[\w-]*/g, "[REDACTED:jwt]"],
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)/g, "[REDACTED:private-key]"],
  // 4b. URL query secrets with generic names (?key=, ?sig=, ?code=, ?access_token=, ?auth=)
  [/([?&](?:key|sig|signature|code|access_token|auth)=)[^&\s"']+/gi, "$1[REDACTED]"],
  // 5. key:value / key=value, quoted or unquoted key, JSON or YAML or URL query (also x-api-key, client_secret, db_password)
  [new RegExp(`(["']?[\\w.-]{0,30}(?:${KEYWORDS})["']?\\s*[:=]\\s*)(?:"[^"\\n]*"|'[^'\\n]*'|[^\\s,;&}"']+)`, "gi"), "$1[REDACTED]"],
];

/** @param {string} s */
export function redact(s) {
  if (typeof s !== "string") return s;
  let out = s;
  for (const [re, rep] of PASSES) out = out.replace(re, rep);
  return out;
}

// object keys that name a secret: their primitive values are redacted whatever the value looks like
const SECRET_KEY = /(authori[sz]ation|api[-_]?key|secret|password|passwd|token|cookie|session|private[-_]?key|client[-_]?secret)/i;

/** Redact every string inside a JSON-like value (returns a copy). Values under secret-looking keys are always redacted. */
export function redactDeep(v) {
  if (typeof v === "string") return redact(v);
  if (Array.isArray(v)) return v.map(redactDeep);
  if (v && typeof v === "object") {
    return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, SECRET_KEY.test(k) && typeof x === "string" && x !== "" ? "[REDACTED]" : redactDeep(x)]));
  }
  return v;
}
