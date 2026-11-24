import readline from "node:readline";

export const GATE_KINDS = ["level4", "apply", "delete", "forcePartial", "human"];

/**
 * @param {{approve?:string[], isTTY?:boolean, ask?:(q:string)=>Promise<string>, who?:string, now?:()=>Date}} [o]
 * Modes: pre-approved (--approve kind), interactive (TTY, type GO), otherwise denied.
 */
export function createGates({ approve = [], isTTY = process.stdin.isTTY && process.stdout.isTTY, ask, who = "cli-user", now = () => new Date() } = {}) {
  for (const k of approve) if (!GATE_KINDS.includes(k)) throw new Error(`unknown gate kind "${k}" (valid: ${GATE_KINDS.join(", ")})`);
  const pre = new Set(approve);
  const decisions = [];
  const prompt = ask ?? ((q) => new Promise((res) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    rl.question(q, (a) => { rl.close(); res(a); });
  }));
  return {
    decisions,
    /** @returns {Promise<{kind:string, approved:boolean, mode:string, who:string, at:string, description:string}>} */
    async request(kind, description) {
      if (!GATE_KINDS.includes(kind)) throw new Error(`unknown gate kind ${kind}`);
      let approved = false, mode;
      if (pre.has(kind)) { approved = true; mode = "pre-approved"; }
      else if (isTTY) {
        const a = await prompt(`\nAPPROVAL GATE [${kind}]\n${description}\nType GO to approve: `);
        approved = a.trim() === "GO";
        mode = approved ? "interactive" : "denied-by-user";
      } else mode = "denied-non-tty";
      const d = { kind, approved, mode, who, at: now().toISOString(), description };
      decisions.push(d);
      return d;
    },
  };
}
