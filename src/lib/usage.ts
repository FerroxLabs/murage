// Turning banked token/cost figures into something a header chip can show.
// Pure, so the numbers can be tested without the components.
import type { Bot, TaskUsage } from "@/state/store";

export const EMPTY_USAGE: TaskUsage = { input: 0, output: 0, costUsd: null, turns: 0 };

/** True when a stored cost is a real number (not null, NaN, or Infinity). */
export function hasFiniteCost(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

/** Sum a set of usages; cost stays null until any of them has one. */
export function sumUsage(items: Array<TaskUsage | undefined>): TaskUsage {
  const out: TaskUsage = { ...EMPTY_USAGE };
  for (const u of items) {
    if (!u) continue;
    out.input += u.input;
    out.output += u.output;
    out.turns += u.turns;
    if (hasFiniteCost(u.cachedInput)) out.cachedInput = (out.cachedInput ?? 0) + u.cachedInput;
    if (hasFiniteCost(u.costUsd)) out.costUsd = (out.costUsd ?? 0) + u.costUsd;
  }
  return out;
}

export function botUsage(bot: Pick<Bot, "tasks">): TaskUsage {
  return sumUsage((bot.tasks ?? []).map((t) => t.usage));
}

/** 950 → "950", 12_400 → "12.4k", 2_300_000 → "2.3M" */
export function formatTokens(n: number): string {
  if (!hasFiniteCost(n)) return "0";
  if (n < 1000) return String(n);
  if (n < 1_000_000) return `${trim(n / 1000)}k`;
  return `${trim(n / 1_000_000)}M`;
}
const trim = (x: number) => (x >= 100 ? Math.round(x).toString() : x.toFixed(1).replace(/\.0$/, ""));

/** Task-picker variant: hide unused tasks and spell out small counts. */
export function formatTaskTokens(total: number): string | null {
  if (!Number.isFinite(total) || total < 1) return null;
  const n = Math.trunc(total);
  if (n < 1000) return n === 1 ? "1 token" : `${n} tokens`;
  const kTenths = Math.round(n / 100);
  if (kTenths < 10_000) return `${formatTenths(kTenths)}k`;
  return `${formatTenths(Math.round(n / 100_000))}M`;
}

const formatTenths = (value: number) => {
  const fraction = value % 10;
  return fraction === 0 ? `${value / 10}` : `${(value - fraction) / 10}.${fraction}`;
};

/** Dollars, with enough precision that a cheap turn isn't "$0.00". */
export function formatUsd(usd: number): string {
  if (!hasFiniteCost(usd)) return "";
  if (usd === 0) return "$0";
  if (usd < 0.01) return `$${usd.toFixed(3)}`;
  return `$${usd.toFixed(2)}`;
}

/** How much of `input` the provider served from its prompt cache. Clamped to
 * `input` so a provider that reports cache reads outside its input figure
 * can never produce a negative "fresh" number. */
export function cachedInput(u: TaskUsage): number {
  return hasFiniteCost(u.cachedInput) ? Math.min(Math.max(0, u.cachedInput), u.input) : 0;
}

/** The in/out breakdown behind the headline figure, with the cached share
 * called out when there is one: "88.2k in (79k cached) · 1.2k out". The
 * headline counts every token the model processed — five short messages
 * on a thread with a system prompt and tool schemas really do cost the
 * model ~17k tokens of reading each turn — so the breakdown is where the
 * "was that really 100k?" question gets answered. */
export function usageDetail(u: TaskUsage): string {
  const cached = cachedInput(u);
  const input = cached > 0 ? `${formatTokens(u.input)} in (${formatTokens(cached)} cached)` : `${formatTokens(u.input)} in`;
  return `${input} · ${formatTokens(u.output)} out`;
}

/** Fresh tokens: what this conversation actually consumed, once the context
 * re-read is taken out.
 *
 * The whole thread rides along on every turn, so `input` counts the same
 * text once per turn — thirty turns over a large thread reaches millions
 * without the person having written anything much. That total is arithmetically
 * true and reads as a runaway meter. Cached input is the machine re-reading
 * its own notes; it is not what someone means by "how much have I used". */
export function freshTokens(u: TaskUsage): number {
  return Math.max(0, u.input - cachedInput(u)) + u.output;
}

/** The chip text. Empty string when nothing has been spent — a fresh task
 * shows no chip.
 *
 * A cost figure appears only when the engine is metered, because only then
 * is it money. On a subscription the same number is a tariff comparison
 * nobody is being charged, and a running dollar total in the header of a
 * conversation you are already paying a flat fee for is alarming in a way
 * that changes behaviour: people use the thing less to avoid a bill that
 * does not exist. It stays available in the tooltip and the Usage panel,
 * where there is room to caption it honestly. */
export function usageChip(u: TaskUsage, billing?: "metered" | "subscription"): string {
  if (u.turns === 0 && u.input + u.output === 0) return "";
  const parts = [`${formatTokens(freshTokens(u))} tok`];
  if (billing === "metered" && hasFiniteCost(u.costUsd)) parts.push(formatUsd(u.costUsd));
  return parts.join(" · ");
}

/** How to caption a cost figure given how the engine is billed. */
export function costCaption(billing: "metered" | "subscription" | undefined): string {
  if (billing === "subscription") return "equivalent: on your subscription, not billed";
  if (billing === "metered") return "billed to your API key";
  return "as reported by the engine";
}

/** One line of the usage report. The `id` is what a test — or a later
 * redesign — names a line by, so the prose can be improved without
 * rewriting the assertions that guard it. */
export interface UsageReportLine {
  id: "stale" | "turns" | "breakdown" | "fresh" | "cache-note" | "no-cache" | "cost" | "no-cost";
  text: string;
}

export interface UsageReportContext {
  billing?: "metered" | "subscription";
  /** A turn is in flight. `usage` is banked once per SETTLED turn, so while
   * this is true every figure below is the one from before the current turn
   * started. Saying so is the difference between a stale number and a lie. */
  busy?: boolean;
  activity?: Bot["activity"];
}

/** True when the bot has a turn running, so the banked figures are behind. */
export function isMidTurn(context: UsageReportContext): boolean {
  return Boolean(context.busy) || context.activity === "working";
}

/** The whole report behind the chip, as lines.
 *
 * ALWAYS THE SAME SHAPE. The old `title` assembled this list with `.filter`,
 * so an engine that reports no cache and no cost silently rendered a two-line
 * stub — measured live as "4 turns / 313k in · 1.3k out" against five lines on
 * a Claude bot — with nothing saying why three lines were missing. Absence is
 * a fact about the engine and it is now stated, not omitted. */
export function usageReport(u: TaskUsage, context: UsageReportContext = {}): UsageReportLine[] {
  const lines: UsageReportLine[] = [];
  if (isMidTurn(context)) {
    lines.push({
      id: "stale",
      text: "Working now; these are the last settled turn's figures. They update when this turn finishes.",
    });
  }
  lines.push({ id: "turns", text: `${u.turns} turn${u.turns === 1 ? "" : "s"}` });
  // The headline is fresh tokens; this is the full arithmetic behind it, so
  // the two can be reconciled instead of looking like a discrepancy.
  lines.push({ id: "breakdown", text: usageDetail(u) });
  if (cachedInput(u) > 0) {
    lines.push({ id: "fresh", text: `${formatTokens(freshTokens(u))} tok new: the figure on the chip` });
    // the whole thread rides along on every turn, so most of "in" is the
    // model re-reading what it already saw — say so, or the figure reads as
    // a bug (issue #527)
    lines.push({ id: "cache-note", text: "cached = context re-read each turn, not new text" });
  } else {
    // Not silence. Without this line the two above simply vanish and the
    // reader is left to guess whether the engine has no cache or the app
    // lost the number.
    lines.push({
      id: "no-cache",
      text: "no cached input reported by this engine; the chip is the whole in + out figure",
    });
  }
  lines.push(
    hasFiniteCost(u.costUsd)
      // Kept here whatever the billing, because there is room to say what it
      // is. Only the chip itself withholds it on a subscription.
      ? { id: "cost", text: `${formatUsd(u.costUsd)} ${costCaption(context.billing)}` }
      : { id: "no-cost", text: "no cost reported by this engine" },
  );
  return lines;
}
