// C10 · owner: shell X2 (producer: leave/draft adapter) → devices A7, find A8 (consumers).
export type DraftState = "clean" | "dirty" | "inFlight";
export interface LeaveDraftForm { id: string; state: () => DraftState; save?: () => Promise<boolean>; discard?: () => void }
/** Leave guard answer: "stay" keeps the owner on the form. */
export type LeaveDecision = "leave" | "stay";
