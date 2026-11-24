/** Rule-based task classifier. Highest matching level wins; a model may raise but never lower it. */

// Each entry is a regex fragment (stems with optional suffixes), matched word-bounded and case-insensitive.
// When in doubt stay strict: a false level 4 only costs a gate, a missed one skips the gate and the audit.
const RULES = [
  { level: 4, words: [
    "auth(?:n|z|enticat\\w*|ori[sz]\\w*)?", "log[- ]?ins?", "sign[- ]?(?:in|up|on)s?", "passwords?", "passwd", "passphrases?", "permissions?", "roles?", "rbac", "acl", "payments?", "billing", "invoices?",
    "charg\\w*\\s+(?:a\\s+)?cards?", "(?:credit\\s+|debit\\s+)?cards?\\s+numbers?", "credit\\s+cards?", "credentials?", "secrets?", "tokens?", "jwts?", "oauth\\d*", "sso", "sessions?", "cookies?",
    "api[- ]?keys?", "2fa", "mfa", "encrypt\\w*", "decrypt\\w*", "pii", "gdpr", "personal\\s+data", "migrat\\w*",
    "drop\\s+(?:\\w+\\s+)?(?:tables?|columns?|databases?)", "truncate", "delete\\s+from", "delete\\s+production", "deploy\\w*", "production", "prod",
    "infrastructure", "terraform", "dns", "firewalls?", "ssl", "tls", "certificates?",
    // personal data, access rights, hashing, live systems
    "e-?mails?", "phones?(?:\\s+numbers?)?", "address(?:es)?", "birth\\s?(?:dates?|days?)", "dob", "ssn", "national\\s+ids?", "admins?", "administrators?", "privileges?", "access\\s+control", "passcodes?", "pins?",
    // health data, pay data, money movement, cloud write access
    "medical", "patients?", "health", "diagnos\\w*", "prescription\\w*", "hipaa", "salar(?:y|ies)", "payroll", "wages?", "compensation",
    "refund\\w*", "stripe", "paypal", "chargebacks?", "payouts?", "transfers?\\s+funds?", "wire\\s+transfers?", "bank\\s+(?:accounts?|details)",
    "s3", "buckets?", "gcs", "blob\\s+storage", "write\\s+access", "iam", "bucket\\s+polic\\w*",
    "hash\\w*", "bcrypt", "argon\\w*", "live(?:\\s+(?:servers?|db|databases?|sites?|systems?))?", "db\\s+upgrades?", "schema\\s+changes?", "customer\\s+data", "user\\s+data",
  ] },
  { level: 3, words: ["new\\s+modules?", "architect\\w*", "databases?", "schemas?", "integrations?\\s+across", "refactor\\w*\\s+across", "multi-?services?", "workflow\\s+engines?"] },
  { level: 2, words: ["features?", "(?:add\\s+)?endpoints?", "apis?", "workflows?", "integrat\\w*", "several\\s+files"] },
  { level: 1, words: ["typos?", "text", "copy", "colou?rs?", "styl\\w*", "renam\\w*", "comments?", "config\\s+values?", "single\\s+files?", "docs?", "documentation", "wording", "readme", "spelling", "grammar", "punctuation", "whitespace", "formatting"] },
];

const compiled = RULES.map((r) => ({
  level: r.level,
  items: r.words.map((w) => new RegExp("\\b(?:" + w + ")\\b", "i")),
}));

export const RISK_RANK = { low: 0, medium: 1, high: 2, critical: 3 };
const COMPLEXITY = { 1: "simple", 2: "moderate", 3: "complex", 4: "critical" };
const RISK = { 1: "low", 2: "low", 3: "medium", 4: "critical" };
const VERIFICATION = { 1: "Basic", 2: "Standard", 3: "Strict", 4: "Strict" };
const REASONING = { 1: "Basic", 2: "Advanced", 3: "Deep", 4: "Deep" };

/**
 * @param {string} task
 * @param {{contextFileCount?:number, levelOverride?:number|null}} [opts]
 */
export function classify(task, { contextFileCount = 0, levelOverride = null } = {}) {
  const reasons = [];
  let level = 0;
  let moderateApi = false;
  for (const g of compiled) {
    for (const re of g.items) {
      const m = re.exec(task);
      if (m) {
        reasons.push(`level ${g.level}: matched "${m[0]}"`);
        level = Math.max(level, g.level);
        if (g.level === 2 && /api|endpoint|integrat/i.test(m[0])) moderateApi = true;
      }
    }
  }
  if (contextFileCount > 5) { reasons.push(`level 3: ${contextFileCount} files in context`); level = Math.max(level, 3); }
  else if (contextFileCount >= 2) { reasons.push(`level 2: ${contextFileCount} files in context`); level = Math.max(level, 2); }
  let unmatched = false;
  if (level === 0) { level = 2; unmatched = true; reasons.push("no rule matched: safe default, level 2 with risk medium (gets an audit)"); }

  let risk = RISK[level];
  if (level === 2 && (moderateApi || contextFileCount >= 2 || unmatched)) risk = "medium";

  const c = {
    complexity: COMPLEXITY[level],
    risk,
    info: contextFileCount > 5 ? "Extensive" : contextFileCount > 0 ? "Moderate" : "Minimal",
    reasoning: REASONING[level],
    execution: level >= 3 ? "Extensive" : "Limited",
    verification: VERIFICATION[level],
    level,
    reasons,
    rulesLevel: level,
    override: null,
  };
  if (levelOverride != null) {
    if (![1, 2, 3, 4].includes(levelOverride)) throw new Error(`--level must be 1-4 (got ${levelOverride})`);
    if (levelOverride > level) {
      c.override = { from: level, to: levelOverride };
      c.level = levelOverride;
      c.complexity = COMPLEXITY[levelOverride];
      c.verification = VERIFICATION[levelOverride];
      c.execution = levelOverride >= 3 ? "Extensive" : "Limited";
      if (RISK_RANK[RISK[levelOverride]] > RISK_RANK[c.risk]) c.risk = RISK[levelOverride];
      c.reasons.push(`level override ${level} -> ${levelOverride} (explicit --level)`);
    } else {
      // an override may only RAISE the level: lowering would skip the gate, audit and validator
      c.overrideIgnored = { requested: levelOverride, rulesLevel: level };
      c.reasons.push(`--level ${levelOverride} ignored: an override may only raise the level (rules say ${level})`);
    }
  }
  return c;
}

/** Merge a model's classification into the rules result: the stricter value always wins. */
export function mergeAssist(rules, assist) {
  if (!assist) return rules;
  const out = { ...rules, reasons: [...rules.reasons] };
  const lvl = Number(assist.level);
  if ([1, 2, 3, 4].includes(lvl) && lvl > out.level) {
    out.reasons.push(`assist raised level ${out.level} -> ${lvl}`);
    out.level = lvl;
    out.complexity = COMPLEXITY[lvl];
    out.verification = VERIFICATION[lvl];
  }
  if (assist.risk in RISK_RANK && RISK_RANK[assist.risk] > RISK_RANK[out.risk]) {
    if (out.level === 1 && RISK_RANK[assist.risk] >= RISK_RANK.medium) { out.level = 2; out.complexity = COMPLEXITY[2]; out.verification = VERIFICATION[2]; out.reasons.push("assist: risk above low, level 1 raised to 2 so an audit can run"); }
    out.reasons.push(`assist raised risk ${out.risk} -> ${assist.risk}`);
    out.risk = assist.risk;
    if (assist.risk === "critical" && out.level < 4) { out.level = 4; out.complexity = COMPLEXITY[4]; out.verification = VERIFICATION[4]; }
  }
  return out;
}
