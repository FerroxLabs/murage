// C11 · owner: devices X1 (producer: purchase predicate + surface allowlist) → find A1/S1, botpages A2 (consumers).
export type CreditState = "ok" | "missing" | "low" | "zero" | "unknown" | "offline";
export type Surface = "desktop" | "phone";
export interface PurchaseContext { surface: Surface; storeBuild: boolean; credit: CreditState; cloud: boolean }
export type MayShowPurchase = (ctx: PurchaseContext, producer: string) => boolean;
/** A row, value or action reaches a phone only if this table lists it. */
export type PhoneAllowlist = ReadonlySet<string>;

/** X1: one answer for "may this producer create, draw or index a purchase action". A Store build never; otherwise only when credit is not fine. */
export const mayShowPurchase: MayShowPurchase = (ctx) => !ctx.storeBuild && ctx.credit !== "ok";

/** A paired phone reaches only routes classed for it. A desktop-class route (route-policy.ts) renders no switch there. */
const PHONE_ROUTE_CLASSES: ReadonlySet<string> = new Set(["companion", "phone", "conversation", "health"]);
export const phoneMayRenderSwitch = (routeClass: string): boolean => PHONE_ROUTE_CLASSES.has(routeClass);

/** The phone Overview request row carries who asked and what state it is in, and nothing about the app or account behind it. */
export interface PhoneRequestRow { id: string; botId: string; title: string; state: string }
export const phoneRequestRow = (row: PhoneRequestRow & Record<string, unknown>): PhoneRequestRow =>
  ({ id: row.id, botId: row.botId, title: row.title, state: row.state });
