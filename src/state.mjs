export const STATES = ["NEW", "CLASSIFIED", "PLANNING", "RETRIEVAL", "READY_FOR_BUILD", "EXECUTING", "AUDIT", "CORRECTION", "APPROVAL_REQUIRED", "VALIDATION", "COMPLETE", "CLOSED", "BLOCKED", "ESCALATED", "CANCELLED"];

/** Allowed transitions. BLOCKED and CANCELLED are reachable from any non-terminal state (added in `canMove`). */
const NEXT = {
  NEW: ["CLASSIFIED", "ESCALATED"],
  CLASSIFIED: ["PLANNING", "RETRIEVAL", "READY_FOR_BUILD", "ESCALATED"],
  PLANNING: ["RETRIEVAL", "READY_FOR_BUILD", "ESCALATED"],
  RETRIEVAL: ["READY_FOR_BUILD", "ESCALATED"],
  READY_FOR_BUILD: ["EXECUTING", "ESCALATED"],
  EXECUTING: ["AUDIT", "VALIDATION", "ESCALATED"],
  AUDIT: ["CORRECTION", "APPROVAL_REQUIRED", "VALIDATION", "ESCALATED"],
  CORRECTION: ["AUDIT", "ESCALATED"],
  APPROVAL_REQUIRED: ["VALIDATION", "ESCALATED"],
  VALIDATION: ["COMPLETE", "ESCALATED"],
  COMPLETE: ["CLOSED"],
  CLOSED: [],
  BLOCKED: [],
  ESCALATED: ["PLANNING"],
  CANCELLED: [],
};
const TERMINAL = new Set(["CLOSED", "BLOCKED", "CANCELLED"]);

export function canMove(from, to) {
  if (TERMINAL.has(from)) return false;
  if (to === "BLOCKED" || to === "CANCELLED") return true;
  return (NEXT[from] ?? []).includes(to);
}

export class IllegalTransition extends Error {}

/** @param {(e:{from:string,to:string,reason:string})=>void} [onEvent] */
export function createState(onEvent = () => {}) {
  let cur = "NEW";
  return {
    get current() { return cur; },
    to(next, reason = "") {
      if (!STATES.includes(next)) throw new IllegalTransition(`unknown state ${next}`);
      if (!canMove(cur, next)) throw new IllegalTransition(`illegal transition ${cur} -> ${next}`);
      const from = cur;
      cur = next;
      onEvent({ from, to: next, reason });
    },
  };
}
