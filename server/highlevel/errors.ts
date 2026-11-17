// SPDX-License-Identifier: AGPL-3.0-or-later
// Dependency-free errors keep operation imports independent of the registry.
export type HighLevelOutcome = "not_applied" | "outcome_unknown";

export class HighLevelError extends Error {
  readonly status: number | undefined;
  /** For a change: not_applied when HighLevel provably did not apply it, outcome_unknown when it may have. */
  readonly outcome: HighLevelOutcome;
  /** The connection needs Reconnect; the tool answer tells the bot to ask the person. */
  readonly signedOut: boolean;
  /** HighLevel's own words quoted in the message (apiMessage), if any: outside content wherever the message reaches a bot. */
  readonly providerDetail: string | undefined;
  constructor(message: string, options: { status?: number; outcome?: HighLevelOutcome; signedOut?: boolean; providerDetail?: string } = {}) {
    super(message);
    this.name = "HighLevelError";
    this.status = options.status;
    this.outcome = options.outcome ?? "not_applied";
    this.signedOut = options.signedOut === true;
    this.providerDetail = options.providerDetail || undefined;
  }
}

/** The turn was stopped before the request was sent. Thrown only before a send, so a change is provably not applied. */
export class HighLevelStopped extends Error {
  readonly reason = "stopped_before_send";
  constructor() {
    super("Stopped. Nothing more was sent to the CRM.");
    this.name = "HighLevelStopped";
  }
}

/** Fixed, local refusal copy; never carries provider response text. */
export class InvoiceReviewRefused extends Error {
  constructor() {
    super('The full invoice details could not be shown for approval. Nothing was sent.');
  }
}
