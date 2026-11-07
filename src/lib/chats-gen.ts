import { useSyncExternalStore } from "react";
export type ChatsGen = { epoch: string; rev: number };
export type GenOrder = "older" | "same" | "newer" | "foreign";
export const compareGen = (a: ChatsGen, b: ChatsGen): GenOrder => a.epoch !== b.epoch ? "foreign" : a.rev === b.rev ? "same" : a.rev < b.rev ? "older" : "newer";
export const validChatsGen = (value: unknown): value is ChatsGen => !!value && typeof value === "object" && typeof (value as ChatsGen).epoch === "string" && Number.isSafeInteger((value as ChatsGen).rev) && (value as ChatsGen).rev >= 0;
let state: { known: ChatsGen | null; proven: boolean } = { known: null, proven: false };
let session = 0;
const listeners = new Set<() => void>();
let replacement: (() => void) | undefined;
const notify = () => { for (const listener of listeners) listener(); };
export const chatsGenSnapshot = () => state;
export const chatsGenSession = () => session;
export function registerChatsGenReplacement(callback: () => void) { replacement = callback; return () => { if (replacement === callback) replacement = undefined; }; }
export function chatsGenUnproven() { session++; state = { ...state, proven: false }; notify(); }
export function chatsGenHello(gen: ChatsGen | undefined) { session++; state = { known: gen ?? state.known, proven: gen !== undefined }; notify(); }
export function chatsGenFrame(gen: ChatsGen, replayed: boolean) {
  if (replayed || !validChatsGen(gen)) return;
  if (!state.known || ["newer", "foreign"].includes(compareGen(gen, state.known))) { state = { ...state, known: gen }; notify(); }
}
export function chatsGenAnswer(gen: ChatsGen | undefined, capturedSession: number): "ok" | "newer" | "stale" | "unproven" {
  if (capturedSession !== session || !validChatsGen(gen)) return "stale";
  if (!state.known) return "unproven";
  const order = compareGen(gen, state.known);
  if (order === "foreign") { chatsGenUnproven(); replacement?.(); return "stale"; }
  if (order === "older") return "stale";
  if (order === "newer") { state = { ...state, known: gen }; notify(); return "newer"; }
  return "ok";
}
export const chatsEligible = (gen: ChatsGen | null | undefined, snapshot = state) => snapshot.proven && !!snapshot.known && !!gen && compareGen(gen, snapshot.known) === "same";
export function useChatsGen() { return useSyncExternalStore(callback => { listeners.add(callback); return () => { listeners.delete(callback); }; }, chatsGenSnapshot, chatsGenSnapshot); }
