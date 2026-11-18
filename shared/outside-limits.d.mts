export type OutsideSurface = "banner-mac" | "banner-win" | "banner-linux" | "menu" | "pill" | "flyout" | "bubble" | "dock";
export interface OutsideEnvelope { readonly maxLines: number; readonly maxLineChars: number; readonly titleChars: number; readonly nameChars: number; readonly repertoire: "ascii" | "extended"; readonly templateLines?: number }
export const OUTSIDE_SURFACES: readonly OutsideSurface[];
export const OUTSIDE_ENVELOPES: Readonly<Record<OutsideSurface, OutsideEnvelope>>;
export function repertoireOk(text: unknown, repertoire: unknown): boolean;
export function envelopeValid(surface: string, envelope: unknown): boolean;
export const REPERTOIRES: readonly ("ascii" | "extended")[];
export function wrappedLineCount(text: string, width: number): number;
export function fitsEnvelope(willRun: unknown, title: unknown, botName: unknown, envelope: OutsideEnvelope | undefined): boolean;
