"""BOT-CREATE-OUTSIDE-1019 r3.3 -- NORMATIVE gate. Pure, stdlib only, no I/O.

ONE function decides every authority question (Astra r3.2 H2): `decide(action, ctx)`. The CONTENT
invariant (I11) is not a separate statement any more; it IS the `content_floor` lines of `decide`, and
the precheck (P3), the route gate (outside-own.ts ownToolGate) and the commit (6.4) all call `decide`.
Port target: server/outside-authority.ts. Parity = vitest replays spec/traces.tsv through the port.
"""

BOT_MANAGEMENT = frozenset({"create_bot", "update_bot", "archive_bot", "restore_bot", "move_bot", "set_team_lead"})
DESKTOP = frozenset({"computer", "cloud-desktop"})
FIXED_SURFACES = ("bulk", "notification", "push", "channel", "question")
CARD_RENDERERS = frozenset({"bot-card@1"})
# 6.5 + Fable A4: a renderer joins only with its full-spec UI test. bot-review-phone@1 is the attested phone
# app sheet (D5 recommendation). cloud-phone (browser), push, notification, channel never activate.
REVIEW_RENDERERS = {
    "computer": frozenset({"bot-review@1"}),
    "cloud-desktop": frozenset({"bot-review@1"}),
    "phone-app": frozenset({"bot-review-phone@1"}),
}
STANDING = frozenset({"host_consent", "folder_trust", "always_allow"})
SETTINGS_GUARD = {"always_allow": frozenset({"computer"}), "host_consent": frozenset({"computer"}),
                  "folder_trust": DESKTOP}


def answer_surface(ident):
    """Derived ONCE from server-authenticated identity (7.1.1). Never reads the request body."""
    via = ident.get("via")
    if via in FIXED_SURFACES:
        return via
    app = ident.get("app")
    if app == "desktop" and ident.get("owners_computer") and not ident.get("cloud"):
        return "computer"
    if app == "desktop" and ident.get("cloud"):
        return "cloud-desktop"
    if app == "phone":
        return "phone-app"
    if ident.get("cloud") and ident.get("scope") == "owner-phone":
        return "cloud-phone"
    return "other-owner"


def desktop_authority(surface):
    return surface in DESKTOP


def owner_seen(card, surface, seen):
    if not desktop_authority(surface):
        return False
    if seen is None:
        return False
    if seen.get("renderer") not in CARD_RENDERERS:
        return False
    if seen.get("digest") != card["specDigest"]:
        return False
    return True


def mint(card, surface, seen, behavior):
    """Inside answerRequest only; automatic answers (NOLIM source=auto, allow rules, remembered grants) never call it."""
    if behavior != "allow":
        return None
    if surface == "question":
        return None
    if card.get("cut"):
        return None
    return {"card": card["id"], "tool": card["tool"], "digest": card["digest"], "eff": card["eff"],
            "gens": set(card["gens"]), "ownerSeen": owner_seen(card, surface, seen), "surface": surface,
            "consumed": False}


def automatic_answer(card):
    """NOLIM source=auto / policy allow (index.ts:9819) and the other automatic respondToRequest allows."""
    return None


def match_pass(passes, gen, tool, digest):
    for p in passes:
        if p["consumed"] or gen not in p["gens"] or p["tool"] != tool:
            continue
        if p["digest"] != digest:
            continue
        p["consumed"] = True                          # synchronously, before any await
        return p
    return None


def commit_reason(origin, live_read, row, driver_ok):
    """6.4 `reason` for a write without owner-seen authority."""
    if origin == "content":
        return "content"
    if live_read is not None:
        return "outside"
    if not driver_ok:
        return "unsettled"
    if row is None:
        return "unsettled"
    if row.settled:                                   # Fable M2 late write
        return "unsettled"
    if row.abnormal:
        return "unsettled"
    if row.marked:
        return "outside"
    return "turn-open"


def decide(action, ctx):
    """The single authority function. Returns (verdict, detail)."""
    kind = action["kind"]

    if kind == "bot":
        tool, gen = action["tool"], action["gen"]
        if ctx.get("authz"):                          # 7.3: a pass never satisfies authorization / state checks
            return ("refuse", ctx["authz"])
        p = match_pass(ctx["passes"], gen, tool, action["digest"])
        origin = ctx["origin"]
        if origin == "content" and p is None:        # content_floor (I11), every BOT_MANAGEMENT tool, marked or not
            minted = any(q["tool"] == tool and gen in q["gens"] for q in ctx["passes"])
            return ("refuse", "C11" if minted else "C5")
        if tool == "archive_bot":
            return ("run", None)
        if p is not None and p["ownerSeen"] and p["eff"] == action["eff"]:
            return ("active", None)
        return ("staged", commit_reason(origin, ctx["live_read"], ctx["row"], ctx["driver_ok"]))

    if kind == "review":
        if action["action"] == "discard":
            return ("discarded", None)
        surface, seen = ctx["surface"], ctx.get("seen")
        if surface not in REVIEW_RENDERERS:
            return ("403", "C13")
        if seen is None or seen.get("renderer") not in REVIEW_RENDERERS[surface]:
            return ("409", "changed")
        if seen.get("digest") != ctx["live_digest"]:
            return ("409", "changed")
        return ("activated", None)

    if kind == "grant":
        sink, route, surface = action["sink"], action["route"], ctx.get("surface")
        if route == "engine":                         # D4, D6, G1/G2/G3/G12: never from an engine-callable route
            return ("no-write", None)
        if route == "settle":                         # D6 at a clean settle only
            return ("write", None) if ctx.get("settle_ok") else ("no-write", None)
        if route == "owner_settings":
            allowed = SETTINGS_GUARD.get(sink)
            if allowed is not None and surface not in allowed:
                return ("no-write", None)
            return ("write", None)
        if route == "owner_answer":
            if sink in STANDING and not desktop_authority(surface):   # 8.2
                return ("once", None)
            return ("write", None)
        raise ValueError("unclassified grant route: " + str(route))   # fail closed: every route is classified

    if kind == "setup_at_settle":                     # 6.7.8 with Fable A5
        e = action["entry"]
        resolve = (ctx["verdict"] == "clean" and e["option"] and ctx["option_now"] and ctx["card_open"])
        if resolve:
            return ("resolve", None)
        return ("keep", "push" if e["push_suppressed"] and ctx["card_open"] else None)

    if kind == "tool":
        if action["tool"] == "allow_for_task":       # D4
            return ("confirm-on-card", None)
        if action["tool"] == "phone":                 # D3: runs at the owner's level, mints nothing
            return ("run", None)
        return ("run", None)

    return ("refuse", "unknown")
