/** Audience handles carry no provider identifiers or answer labels. */
export type DisplayOption = Readonly<{ handle: string; label: string; description?: string }>;
export type DisplayQuestion = Readonly<{
  handle: string; question: string; header?: string; options: readonly DisplayOption[];
  multiSelect: boolean; allowOther: boolean; secret?: boolean;
}>;
export type DisplayCommand = Readonly<{ handle: string; label: string; description?: string; hint?: string; takesArguments: boolean }>;
export type DisplayAnswer = Readonly<{ questionHandle: string; optionHandles: readonly string[]; other?: string }>;
export type DisplayAction =
  | Readonly<{ requestHandle: string; action: 'answer'; answers: readonly DisplayAnswer[]; sentAsMessage?: true }>
  | Readonly<{ requestHandle: string; action: 'skip' }>
  | Readonly<{ requestHandle: string; action: 'allow' | 'deny' }>;
export type DisplayCommandSend = Readonly<{ commandHandle: string; args: string; sendId: string }>;
export type DisplayCommandsView = Readonly<{ engine: string; driver: string; status: 'unsupported' | 'ready' | 'unknown'; commands: readonly DisplayCommand[] }>;
