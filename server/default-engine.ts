// WHICH ENGINE A BRAND NEW BOT LANDS ON.
//
// Pure, and in its own file, because this one decision is the difference
// between a person meeting the engine Murage ships and a person meeting
// somebody else's, and it is worth being able to state it as a table in a
// test rather than reasoning about it inside a 15,000 line server.
//
// The shape is structural, like the rest of this server's readings, so
// nothing here pulls the engine registry's own types into the contract.

export interface EngineReading {
  instanceId: string;
  driverKind?: string;
  snapshot: { state: string; authenticated?: boolean };
  models: { default?: string };
}

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
  const usable = available.filter((d) => d.models.default);
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
  const fuigo = usable.find((d) => d.driverKind === "fuigoAgent");
  const best = Math.min(...usable.map(signInRank));
  const preferred = usable.filter((d) => signInRank(d) === best);
  const pick =
    fuigo ??
    preferred.find((d) => d.driverKind === "claudeAgent") ??
    preferred[0];
  return { instanceId: pick?.instanceId ?? "", model: pick?.models.default ?? "" };
}
