export type VolumeKind = 'backup' | 'data' | 'shared';
export type BackupLayout = 'shared' | 'split' | 'unknown';
export interface BackupRoom { destinationRef: string; at: number; layout: BackupLayout; mode: 'pinned' | 'either'; floors: Partial<Record<VolumeKind, number | null>> }
export interface BackupVolume { kind: VolumeKind; requiredBytes: number; freeBytes?: number; neededBytes?: number; blocking:boolean; alternative:boolean; floorBytes?:number|null }
export interface SpaceRequirement { short: boolean; drive: 'backup' | 'data' | null; requiredBytes?: number; neededBytes?: number; volumes: BackupVolume[] }
export function volumeLayout(backup: unknown, data: unknown): BackupLayout;
export function floorFor(free: number | undefined, leftover?: number): number | null;
export function implicatedVolumes(step: string | undefined, platform: string): ('backup' | 'data')[];
export function spaceRequirement(input: {layout: BackupLayout; estimates?: {backup?: number; data?: number}; room?: BackupRoom; free?: Partial<Record<VolumeKind, number | undefined>>}): SpaceRequirement;
