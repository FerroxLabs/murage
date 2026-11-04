// WHICH ENGINE A BRAND NEW BOT LANDS ON.
//
// Pure, and in its own file, because this one decision is the difference
// between a person meeting the engine Murage ships and a person meeting
// somebody else's, and it is worth being able to state it as a table in a
// test rather than reasoning about it inside a 15,000 line server.
//
// The shape is structural, like the rest of this server's readings, so
// nothing here pulls the engine registry's own types into the contract.

import type { ModelCatalog } from "./contracts.ts";
import { filterFluxRows } from "./flux-surface.ts";

export interface EngineReading {
  instanceId: string;
  driverKind?: string;
  snapshot: { state: string; authenticated?: boolean };
  models: { default?: string; options?: ReadonlyArray<{ id: string }> };
}

/** 1.0.4 (168): the model a new bot gets on an engine, the engine's own
 * default or else the first model it lists. An engine that lists nothing has
 * no model to give (the Fuigo-with-no-key case below). */
export function defaultModel(instance: Pick<EngineReading, "models">): string {
  return instance.models.default || instance.models.options?.[0]?.id || "";
}

/** 1.0.14 FIRST-ENGINE-REPICK (BR2): the usable Fuigo instances in a scan, and the usable others. Usable means available with a model to
 * give (defaultModel: the named default, else the first listed). Reads no sign-in field. Birth (BIRTH-FUIGO-1014) and the engine pass
 * share this one split. */
export function fuigoSplit<T extends EngineReading & { enabled?: boolean }>(described: readonly T[]): { fuigo: T[]; others: T[] } {
  // BN3 (BIRTH-FUIGO-1014 r2): a Fuigo counts exactly when birth would put a bot on it (fuigoUsable), so an empty bot birth would have
  // put on Fuigo is moved there by the pass. Other engines: available with a model to give.
  const fuigo = described.filter(entry => entry.driverKind === "fuigoAgent" && fuigoUsable(asCatalogued(entry)));
  const others = described.filter(entry => entry.driverKind !== "fuigoAgent" && entry.snapshot.state === "available" && defaultModel(entry) !== "");
  return { fuigo, others };
}

/** The model the engine pass moves a bot to on a usable Fuigo: the birth model (fuigoBirthModel), never another reading. */
export function fuigoMoveModel(entry: EngineReading & { enabled?: boolean }): string {
  return fuigoBirthModel(asCatalogued(entry));
}

function asCatalogued(entry: EngineReading & { enabled?: boolean }): Parameters<typeof fuigoBirthModel>[0] {
  return { driverKind: entry.driverKind, enabled: entry.enabled, models: { ...entry.models, default: entry.models.default ?? "", options: entry.models.options ?? [] } as ModelCatalog };
}

/** 1.0.15 BIRTH-FUIGO: the catalogue a new bot may be born on, the one describe() publishes (registry.ts, same filterFluxRows
 * call): keyless Flux rows removed first. With no Flux key, Fuigo's static list (all Flux tiers) filters down to nothing, so a
 * keyless Fuigo has no birth model; a `fuigo login` catalogue keeps its own rows. Reads the key from env at the call. */
export function birthModels(x: { driverKind: string; models: ModelCatalog }): ModelCatalog {
  return filterFluxRows(x.models, x.driverKind);
}

/** 1.0.15 BIRTH-FUIGO: the model a bot is born on when this instance is a usable Fuigo, else "". Usable = a Fuigo, enabled, with
 * a birth model (defaultModel of the filtered catalogue: the named default, else the first listed). Shared with the engine pass
 * (BN3) so "Fuigo usable" means one thing. Reads no sign-in field. */
export function fuigoBirthModel(x: { driverKind?: string; enabled?: boolean; models: ModelCatalog }): string {
  if (x.driverKind !== "fuigoAgent" || x.enabled === false) return "";
  return defaultModel({ models: birthModels({ driverKind: x.driverKind, models: x.models }) });
}

export const fuigoUsable = (x: Parameters<typeof fuigoBirthModel>[0]): boolean => fuigoBirthModel(x) !== "";

export interface EngineChoice {
  instanceId: string;
  model: string;
}

export function pickDefaultEngine(described: readonly EngineReading[]): EngineChoice {
  const available = described.filter((d) => d.snapshot.state === "available");
  // Deliberately NO fallback to described[0]. Handing a bot an engine whose
  // CLI isn't installed makes it look ready and then fail on send with a raw
  // spawn ENOENT — the single worst first-run experience, and the one every
  // user with no CLIs used to get. An empty selection is honest: the UI shows
  // the setup path instead of a bot that cannot answer.
  // Fuigo first, then Claude. Fuigo is the only engine Murage SHIPS a binary
  // for, so on a machine with no CLIs installed it is the one that can be
  // "available" at all — which is the entire zero-terminal promise. Claude
  // stays second because on a developer's machine it usually is installed and
  // it was the previous default; a fresh install simply never reaches it.
  // "available" means the CLI answered --version, NOT that it can do anything.
  // Murage SHIPS fuigo's binary, so fuigo is always available — and with no
  // Flux key and no `fuigo login` its catalog merges down to nothing, which
  // would hand every new bot `{instanceId:"fuigo", model:""}`: a bot that looks
  // configured and is not. A non-empty catalog is the check that prevents it.
  //
  // NOT `snapshot.authenticated !== false` as well, though that reads like the
  // stronger guard. It is reported conservatively by several drivers, so
  // requiring it emptied this list on installs where engines work perfectly
  // well — server/unattended.test.ts caught it: a delegated teammate created
  // with no explicit selection got NO engine at all, its turn never ran, and
  // the failure surfaced as "the delegated turn auto-approved". Bisected
  // against the pre-change commit rather than guessed at.
  const usable = available.filter((d) => defaultModel(d));
  // F2 — a new bot used to be handed `codex` on a machine where codex had
  // never been signed in, because this preference could not see the difference.
  // `authenticated` is still NOT a filter, for the reason spelled out above:
  // several drivers report it conservatively and filtering on it once left a
  // delegated teammate with no engine at all (server/unattended.test.ts). It is
  // a RANKING instead. An engine that says it is signed in wins over one that
  // says it is not; an engine that does not answer the question keeps the
  // benefit of the doubt and sits between them. Every engine that was pickable
  // before is still pickable, so nothing that worked can stop working — the
  // only change is which of several candidates a brand-new bot lands on.
  const signInRank = (d: (typeof usable)[number]) => {
    // A snapshot that never answers the question (an engine that is not there
    // at all) keeps the benefit of the doubt, same as `undefined` below.
    // Fuigo's "authenticated" means a METERED Murage/Flux key or login, not a
    // purchase the person already made, so it never earns the signed-in rank 0
    // (a tie with a signed-in Claude/Codex went to Fuigo via the preference below).
    if (d.driverKind === "fuigoAgent") return 1;
    const signedIn = "authenticated" in d.snapshot ? d.snapshot.authenticated : undefined;
    return signedIn === true ? 0 : signedIn === undefined ? 1 : 2;
  };
  // FUIGO OUTRANKS THE SIGN-IN RANKING, RATHER THAN COMPETING INSIDE IT.
  //
  // It used to be the other way round: the sign-in rank was applied first and
  // the Fuigo preference only chose between the survivors. On any machine
  // with Claude Code signed in, Claude sat at rank 0 and Fuigo at rank 1, so
  // Fuigo lost before the preference was ever consulted. A developer's
  // machine is the common case, and it meant the engine Murage SHIPS almost
  // never became the default on exactly the machines the team tests on.
  //
  // This is safe because of what `usable` already guarantees: an engine is
  // only in this list when its CLI answered and its catalogue is NOT empty.
  // A Fuigo with no key and no login merges its catalogue down to nothing and
  // is therefore not here at all, so preferring it can never hand somebody a
  // bot that looks configured and cannot answer. That was the whole reason
  // the catalogue check exists, and it is still doing that job.
  //
  // The sign-in ranking keeps its job for everything else: between Claude,
  // Codex and the rest, an engine that says it is signed in still wins, and
  // one that does not answer the question keeps the benefit of the doubt.
  // SIGNED IN IS THE SIGNAL THAT SAYS "THEY ALREADY PAY FOR THIS".
  //
  // This ordering was briefly inverted, to put the engine we ship above
  // everything. That was wrong, and wrong in the way that costs a customer
  // money: on a machine with Claude Code signed in, the moment a Flux key
  // landed the Chief moved OFF their flat-rate subscription and onto our
  // meter. They are paying twice for the same sentence, and they find out
  // on a bill rather than from us.
  //
  // Fuigo is still the default on the machine this product is for, because
  // an engine nobody has signed into is not usable and drops to the bottom
  // rank, and a machine with nothing installed has only Fuigo in the list at
  // all. What it must not do is outrank something the person has already
  // bought.
  //
  // Note the scope: this is the INTERACTIVE assistant. Scheduled work is a
  // separate question, because a subscription is flat-rate but rate-limited
  // and draining it with background routines would make Murage the thing
  // that broke the tool they bought for their day job.
  const best = Math.min(...usable.map(signInRank));
  const preferred = usable.filter((d) => signInRank(d) === best);
  const pick =
    preferred.find((d) => d.driverKind === "fuigoAgent") ??
    preferred.find((d) => d.driverKind === "claudeAgent") ??
    preferred[0];
  return { instanceId: pick?.instanceId ?? "", model: pick ? defaultModel(pick) : "" };
}

// The last engine choice, remembered between launches. Probing every engine
// costs about two seconds, and it only matters when a bot is created, so a
// start with bots already in place reads this and refreshes it in the
// background instead of holding the port closed for the probe.
import { mkdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";
import { writeFileAtomic } from "./atomic.ts";

export function readRememberedEngine(file: string): EngineChoice | null {
  try {
    const value = JSON.parse(readFileSync(file, "utf8")) as Partial<EngineChoice>;
    return typeof value.instanceId === "string" && typeof value.model === "string" ? { instanceId: value.instanceId, model: value.model } : null;
  } catch { return null; }
}

export function rememberEngine(file: string, choice: EngineChoice): void {
  try {
    mkdirSync(dirname(file), { recursive: true });
    writeFileAtomic(file, JSON.stringify({ instanceId: choice.instanceId, model: choice.model }), { mode: 0o600 });
  } catch { /* a missing memory only means the next start probes first */ }
}

export const BOOT_PROBE_WAIT_MS = 20_000;

/** The choice to start with. With bots present and a remembered choice, that
 * choice at once and `refreshed` resolves once the probe has run; otherwise
 * the probe is awaited (a first run, or nothing remembered). */
export async function bootEngineChoice(opts: {
  hasBots: boolean; file: string; probe: () => Promise<EngineChoice>; adopt: (choice: EngineChoice) => void;
  /** Whether the remembered choice still names an engine and model that exist
   * and can be used now (registered, enabled, listed, with a non-empty catalog).
   * A choice that fails this is not adopted, and the probe is awaited as on a
   * first run. Omitted means every remembered choice counts. */
  usable?: (choice: EngineChoice) => boolean;
  /** With bots in place, the longest the start waits for the probe when nothing can be remembered (default BOOT_PROBE_WAIT_MS). */
  probeWaitMs?: number;
}): Promise<{ refreshed: Promise<void> }> {
  const run = async () => { const choice = await opts.probe(); opts.adopt(choice); rememberEngine(opts.file, choice); };
  const saved = opts.hasBots ? readRememberedEngine(opts.file) : null;
  const remembered = saved && (opts.usable?.(saved) ?? true) ? saved : null;
  if (!remembered) {
    // A first run needs the choice to seed its first bot: the probe is awaited whole. Bots in place need it only for the next new bot,
    // so a slow probe finishes in the background and the port opens on time.
    if (!opts.hasBots) { await run(); return { refreshed: Promise.resolve() }; }
    const probing = run();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const waited = new Promise<void>((resolve) => { timer = setTimeout(resolve, opts.probeWaitMs ?? BOOT_PROBE_WAIT_MS); });
    try { await Promise.race([probing, waited]); } finally { clearTimeout(timer); }
    return { refreshed: probing.catch(() => {}) };
  }
  opts.adopt(remembered);
  return { refreshed: run().catch(() => {}) };
}
