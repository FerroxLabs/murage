import type { ModelSelection } from './contracts.ts';
import type { WriteReason } from './turn-settle.ts';
export interface HeldBotWork {
  kind: 'delegate' | 'ask' | 'assign' | 'group-add' | 'routine-confirm';
  peer?: import('./held-peer-authority.ts').HeldPeerAuthority;
  fromBotId: string; fromThreadId: string; text: string; ref?: string;
}
export interface StagedBot {
  rev: number; at: number; generation: string; reason: WriteReason; source?: string; byThreadId: string; byBotId: string;
  intended: { autoApprove: boolean; fullAccess: boolean; noLimits: boolean; lead: boolean; modelSelection?: ModelSelection };
  heldWork: HeldBotWork[];
}
export interface PendingBotRevision {
  rev: number; at: number; generation: string; reason: WriteReason; source?: string; byThreadId: string; byBotId: string;
  fields: { name?: string; role?: string; instructions?: string; modelSelection?: ModelSelection; section?: string; lead?: true; restore?: true };
  baseRevision: string;
}
