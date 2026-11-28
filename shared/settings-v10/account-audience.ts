// C4 · owner: access AG0 (producer) → access AC1, accept (consumers).
export interface AudienceRecipient { kind: "bot" | "chat" | "routine"; id: string; botId: string; name: string }
export interface AudienceExclusion { kind: "bot" | "chat" | "routine"; idHash: string; reason: string }
export interface AccountAudience { toolkit: string; recipients: AudienceRecipient[]; exclusions: AudienceExclusion[]; digest: string }
/** 409 carries the whole current list. */
export interface AccountAudienceConflict { error: "AUDIENCE_CHANGED"; audience: AccountAudience }
