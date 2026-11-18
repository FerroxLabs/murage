export interface ComposioHold { scope: string; notBefore: number; failureStreak: number; status: number; generation: number }
export interface ComposioAdmissionStore { load(): ComposioHold[] | Promise<ComposioHold[]>; save(holds: ComposioHold[]): void | Promise<void> }
export function createComposioAdmissionStore(dataDir: string): ComposioAdmissionStore;
