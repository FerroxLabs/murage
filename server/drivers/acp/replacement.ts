/** Replacement sessions and the three-way prompt write (ACP-EFFORT-1018 r9 4.4, R-PUBLISH). */
export type PromptWrite = "unwritten" | "written" | "uncertain";

/** K1 written; K2 closed or failed before the bytes entered the stream; K3 anything else is uncertain. */
export function promptWriteResult(error: Error | null | undefined, accepted: boolean | undefined): PromptWrite {
  if (!error && accepted === true) return "written";
  if (error && accepted === false) return "unwritten";
  return "uncertain";
}

export interface ReplacementHooks {
  restore(previousId: string): void;
  retire(id: string): void;
  publish(): void;
  notWritten(): void;
  record(fields: object): void;
}

export class Replacement {
  private previous: string | null = null;
  private current: string | null = null;
  private done = false;
  private opened = false;
  private readonly hooks: ReplacementHooks;
  constructor(hooks: ReplacementHooks) { this.hooks = hooks; }

  /** The first open in a turn records the previous id; a later open keeps it. */
  open(previousId: string, newId: string): void {
    if (!this.opened) { this.previous = previousId; this.opened = true; }
    this.current = newId;
    this.done = false;
  }
  get active(): boolean { return this.opened && !this.done; }

  /** First call wins; later calls are ignored. */
  finish(result: PromptWrite | "none"): void {
    if (!this.active || this.previous === null || this.current === null) return;
    this.done = true;
    const previous = this.previous, current = this.current;
    this.hooks.record({ replacement: result });
    if (result === "written") {
      this.hooks.publish();
      this.hooks.retire(previous);
      return;
    }
    this.hooks.restore(previous);
    this.hooks.retire(current);
    if (result === "unwritten") this.hooks.notWritten();
  }
}
