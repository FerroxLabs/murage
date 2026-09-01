# Theme collapse — four skins to Light / Dark / Automatic

Implementation spec. Every colour claim below carries a hex and a measured
contrast ratio; nothing is asserted from taste. The two proposed palettes were
run through the repo's own `scripts/check-skin-contrast.mjs` (unmodified logic,
path redirected at a scratch copy of `styles.css`) plus fifteen further pairs
the script does not yet measure. Both pass all of them.

---

## 0. Where I think the plan is wrong, and where it is right

**The decision to collapse is right and I am not reopening it.** Four skins is a
personality problem, not a palette problem: the app has one identity, and a
picker that asks you to pick one of four moods says the identity has not been
decided. Two palettes plus "follow the OS" is what a desktop app owes its user.

Three things in the brief need correcting or extending, all in the same
direction — the change is *bigger than the CSS*:

1. **"Wayland's light and dark themes are coherent" is only two-thirds true.**
   The neutral ramps are excellent and I have taken them nearly verbatim. But
   Wayland's light mode has a real, unfixed accessibility failure that Murage
   must **not** copy: brand orange `#ff6b35` is used identically in both modes,
   and on a light ground it measures **2.49:1 against `#f0f0f0`** and carries
   white lettering at **2.84:1**. There is no light ground on which `#ff6b35`
   reaches the 3:1 that WCAG 1.4.11 asks of a control boundary — the arithmetic
   forbids it (§3.4). Murage's light mode therefore darkens the orange. That is
   a deliberate divergence from Wayland's stated "orange is identical across
   modes" rule, and it is the single largest design decision in this document.
   Wayland's *semantic* colours (`#34d399` / `#fbbf24` / `#f87171`) have the
   same problem on light and are likewise darkened.

2. **`data-skin` naming: leave it alone.** Same reasoning the coordinator
   applied to the token names. Renaming `data-skin` → `data-theme`,
   `src/lib/skins.ts` → `theme.ts`, `SkinPicker` → `ThemeSwitcher` touches six
   files, two test files and one Electron module for zero user-visible benefit,
   and `src/styles.css` is contended right now. Rename the **label** ("Skin" →
   "Appearance"); keep the attribute, the module path and the localStorage key.
   Note it as a follow-up, not part of this change.

3. **Found in the blast radius: the Windows cold start is already broken.**
   `electron/main.mjs:1359` sets `waitsForSkinSync = process.platform === "win32"`
   and `:1371` hides the window (`show: !waitsForSkinSync`) until the
   `desktop:skin` handshake recolours the native caption overlay. But the
   handler at `electron/main.mjs:1663` only validates and returns — it never
   calls `win.show()`, and nothing anywhere calls `setTitleBarOverlay`
   (`windowChromeOptions` returns `{}` on Windows, so there is no overlay to
   recolour). `skinChrome()` in `electron/skin-overlay.cjs` is exported and
   tested but imported by nobody. **Consequence: every Windows cold start sits
   invisible for the full 5-second `skinSyncFallback` timeout.** This is not
   caused by the theme collapse but it lives in exactly the files this change
   edits, so §7.4 specifies the fix alongside.

Everything else in the brief stands.

---

## 1. What Wayland actually uses

Source of truth, all read-only:

| What | Path |
| --- | --- |
| Token definitions, both modes | `~/dev/wayland/app/src/renderer/styles/themes/default-color-scheme.css` (440 lines) |
| Theme-independent base + scrollbars | `~/dev/wayland/app/src/renderer/styles/themes/base.css` |
| Architecture notes | `~/dev/wayland/app/src/renderer/styles/themes/README.md` |
| TS mirror of the token names | `~/dev/wayland/app/src/renderer/styles/colors.ts` |
| Preference hook (`light`/`dark`/`system`) | `~/dev/wayland/app/src/renderer/hooks/system/useTheme.ts` |
| Three-option switcher UI | `~/dev/wayland/app/src/renderer/components/settings/ThemeSwitcher.tsx` |
| Token-drift validator | `~/dev/wayland/app/scripts/check-ui-tokens.js` |

### 1.1 Structure

One file, two blocks. Light is `:root` (plus `body[arco-theme='light']`);
dark is `[data-color-scheme='default'][data-theme='dark']` (plus
`body[arco-theme='dark']`, required to outrank Arco's own body-level rules).
Mode-invariant foundations — spacing, radius, type, line-height, motion,
shadow — sit in a separate `:root` block above both. The switcher writes
`data-theme` on `<html>` and `arco-theme` on `<body>`.

Murage's `[data-skin]` model is the same idea with one fewer axis and no
component-library override problem. **Nothing about Wayland's structure should
be imported.** Only the values.

### 1.2 The ramps (verbatim from the file)

**Light neutrals** — pure neutral grey, no hue cast at all:

```
--bg-base #ffffff  --bg-1 #f7f7f7  --bg-2 #f0f0f0  --bg-3 #e5e5e5
--bg-4   #d4d4d4  --bg-5 #b3b3b3  --bg-6 #777777  --bg-9 #2a2a2a  --bg-10 #0d0d0d
--text-primary #0d0d0d  --text-secondary #333333  --text-dim #555555
--text-placeholder #6b6b6b  --text-muted #777777  --text-disabled #aaaaaa
--border-light #e5e5e5  --border-base #d4d4d4  --border-bright #bfbfbf  --border-mid #999999
--bg-hover #f0f0f0  --bg-active #e5e5e5  --input-bg #ffffff  --input-border #d4d4d4
--bg-tint #fff5ef   (warm tint, user message bubbles)
```

**Dark neutrals** — the file documents three iterations to get here, and says
why (`#0f` cards were invisible on a `#0a` page; a 16-step delta was still too
subtle at retina density; `#222` at a 24-step delta is the one that works):

```
--bg-base #0a0a0a  --bg-1 #222222  --bg-2 #2a2a2a  --bg-3 #353535
--bg-6 #4d4d4d  --bg-8 #777777  --bg-10 #f5f5f5
--text-primary #f5f5f5  --text-secondary #c0c0c0  --text-muted #9a9a9a
  ("bumped from #7a (4.2:1) to pass WCAG AA on bg-base")
--text-placeholder #b8b8b8  --text-disabled #555555  --text-dim #6b6b6b
--border-light #353535  --border-base #4d4d4d  --border-bright #777777
--bg-hover #1a1a1a  --bg-active #262626  --input-bg #1c1c1c  --input-border #383838
--bg-tint #1a130f  --workspace-btn-bg #161616  --dialog-fill-0 #161616  --fill #111111
```

**Brand, identical in both modes:** `--brand #ff6b35`, `--brand-hover #ff8255`,
`--brand-pressed #cc5529`, `--brand-light #ffe6db` (light) / `#1f1612` (dark).
The Arco primary ramp: `#ffe6db #ffd0bf #ffb399 #ff9670 #ff8255 #ff6b35 #e85a28
#cc5529 #99401e #4d2010`.

**Semantics, identical in both modes:** `--success #34d399`, `--warning
#fbbf24`, `--danger #f87171`.

### 1.3 Honest assessment

- The **dark** ramp is genuinely good and hard-won; the file's own comments show
  it was iterated against real screenshots. Take it.
- The **light** ramp is good but plain — pure greys, no warmth anywhere except
  `--bg-tint`. That is a feature, not a gap: it lets the orange be the only
  colour in the room.
- The **brand orange invariance** is the incoherent part. `#ff6b35` on a light
  ground fails 1.4.11 as a button boundary and fails 1.4.3 as label text, and
  Wayland ships it anyway. Murage's `check-skin-contrast.mjs` would reject it on
  sight. Diverge.
- Wayland's **light semantic colours are decorative**: they are used as
  `--success-soft-bg` / `--success-soft-border` (10 % fills with 30 % borders),
  never as body text. Murage *does* use them as text (`text-danger` × 100,
  `text-success` × 54, `text-warning` × 44), so Murage needs darkened light
  variants that Wayland simply does not have.

### 1.4 The Murage constraint that agrees with Wayland

`src/lib/mascot.ts:67` — `EMBER_COLORS.orange = "#FF6B35"`. Murage's default
agent colour is **byte-identical to Wayland's Forge Orange**. The two products
already share a brand hue. That settles the accent family: orange, not a
"derived" substitute, and the dark palette can use `#ff6b35` unchanged.

---

## 2. The token contract Murage's skins must satisfy

### 2.1 Audit: which properties does each skin block define?

Machine-generated from the current `src/styles.css` (`B` = defined in the
`@theme` / `:root` base; `M A F L` = midnight / atelier / foundry / lagoon):

```
 B MAFL  --color-accent            B MAFL  --color-ink
 B MAFL  --color-accent-border     B MAFL  --color-ink-secondary
 B MAFL  --color-accent-ink        B MAFL  --color-inset
 B MAFL  --color-accent-text       B MAFL  --color-panel
 B MAFL  --color-app               B MAFL  --color-raised
 B MAFL  --color-bubble-user       B MAFL  --color-raised-hover
 B MAFL  --color-card              B MAFL  --color-scrollbar
 B MAFL  --color-control           B MAFL  --color-success
 B MAFL  --color-danger            B MAFL  --color-success-ink
 B MAFL  --color-danger-ink        B MAFL  --color-warning
 B MAFL  --color-ember-line        B MAFL  --font-sans
 B ·AFL  --color-focus   <-- PARTIAL
 B MAFL  --color-hairline          ·  MAFL  --radius-lg
                                   ·  MAFL  --radius-xl
```

**Result: the landmine the coordinator was worried about does not exist here.**
Deleting `[data-skin="foundry"]` and `[data-skin="lagoon"]` orphans nothing —
every property they define is also defined by midnight and atelier. Two smaller
findings did fall out, and both are real:

- **`--color-focus` is defined by three of four skins.** Midnight omits it and
  silently inherits the `@theme` default `#459ffe` (Grok blue). The invariant
  that is *supposed* to catch this — `skins.test.ts` "defines the same tokens in
  every skin" — measures every skin against `tokensOf(DEFAULT_SKIN)`, and
  `DEFAULT_SKIN` is midnight, so the reference set has a hole exactly where
  midnight has one. A new skin could omit `--color-focus` today and the suite
  would stay green. §9.1 fixes this by making the reference the **base** block
  rather than the default skin.
- **`--radius-lg` / `--radius-xl` have no base declaration.** All four skins set
  them; nothing in `@theme` or `:root` does. A skin that omitted them would fall
  through to Tailwind v4's own theme defaults rather than erroring — a silent
  fallback of precisely the class `check-ui-tokens.js` was written to catch.

### 2.2 The full set a palette must define

24 colour tokens + `--font-sans` + 2 radii. Consumption sites worth knowing
before changing a value:

| Token | Where it lands |
| --- | --- |
| `--color-focus` | `styles.css:353` — `:focus-visible { outline: 2px solid … ; outline-offset: 2px }`. The offset puts the ring **outside** the control, so it lands on whatever surface is behind it, not on the control. |
| `--color-accent-ink` | `styles.css:989` — `.bg-accent { color: … }`. Unlayered, so it beats the ~20 hardcoded `text-white` call sites. This is the token that lets an accent be bright. |
| `--color-danger-ink` / `--color-success-ink` | `styles.css:992` / `:995`, same mechanism. |
| `--color-scrollbar` | `styles.css:380` (`scrollbar-color`) **and** `:390` (`::-webkit-scrollbar-thumb`) — Chromium honours one path or the other, never both, so they are kept in sync. |
| `--color-ember-line` | `styles.css:573` — the mascot's second speed line, drawn against the app ground. |
| `--color-raised-hover` + `--color-ink-secondary` | The disabled-button rule at the foot of the file: `button:disabled.bg-accent` repaints to `raised-hover` / `ink-secondary` rather than fading, because `opacity-40` on a light ground destroyed the label. **This pair must clear 4.5:1** and the current script does not measure it. |
| `--color-control` | The tone a chip/row takes when it sits **on** a card. Exists because atelier and lagoon both set `raised` to the same pure white as `card`, which made every raised element on a card invisible. |

---

## 3. The two palettes

### 3.1 The four decisions that carry the design

**1 — The neutral has no hue bias, in either mode.** Wayland's ramps are pure
grey and that is the correct call for a product whose accent is a saturated
orange: any warmth in the ground competes with the accent and turns the whole
app sepia (which is what foundry did, and is a fair part of why it reads as a
costume). Atelier's cream and lagoon's teal go with them. The **only** warm
surfaces that survive are the two Wayland also tints — the user's own message
bubble (`--color-bubble-user`) and, in light, nothing else. One warm object in a
grey room reads as deliberate; a warm room reads as a filter.

**2 — Orange is the accent in both modes, but not the same orange.**
Dark keeps `#ff6b35` exactly — the Wayland brand value, the Murage mascot value.
Light steps it down to `#b8481f`, roughly between Wayland's `--primary-8`
(`#cc5529`) and `--primary-9` (`#99401e`). This is forced, not stylistic: see
§3.4. The bright brand orange survives in light as `--color-accent-border`
(`#cc5529`, Wayland `--primary-8`), so a filled accent button still wears a
brand-bright edge over a legible fill.

**3 — Surfaces step in one direction per mode, and `inset` always goes darker
than the card.** Dark rises `app #0a0a0a → panel #171717 → card #1f1f1f →
raised #2a2a2a → raised-hover #353535`; light rises `app #f0f0f0 → panel #f7f7f7
→ card/raised #ffffff`, with `raised-hover #e5e5e5` and `control #d4d4d4` coming
back **down** because there is nothing above white. In both modes `inset` sits
one step *below* the card (dark `#121212`, light `#eaeaea`) — a single rule for
"the composer field is a hole, not a tile", instead of the per-skin improvisation
the four skins each did differently. In dark there is no room below `#0a0a0a`,
so `inset` still sits above the app ground; it is below the *card*, which is the
surface it is read against.

**4 — Shape and type stop being theme-dependent.** All four current skins vary
`--font-sans` (Inter vs. system-ui) and `--radius-lg` / `--radius-xl` (4/8, 6/10,
8/12, 8/14 px). That made sense when a skin was a character. It does not when a
theme is lighting: the same app should not change its corner radius when the sun
goes down, and on a laptop running Automatic it would do so twice a day. Both
palettes ship **Inter** and **8 px / 12 px** — which are also Wayland's
`--radius-button: 8px` and `--radius-card: 12px`.

### 3.2 Dark — paste-ready

Replaces `[data-skin="midnight"]`. These values also become the `@theme`
defaults (§7.1), since dark is the default palette.

```css
/* ── Dark ──────────────────────────────────────────────────────────────────
   Wayland's dark neutral ramp, near-verbatim, carrying Forge Orange #ff6b35
   unchanged — the same hex as EMBER_COLORS.orange, so the accent and the
   default agent are literally the same colour.

   The accent is the brightest thing on screen and carries near-black
   lettering (6.23:1), not white — white on this orange measures 2.84:1 and
   is not an option. That inversion is only possible because
   --color-accent-ink exists.

   Every pair below is measured; see docs/plans/skins/THEME-COLLAPSE.md §3.5.
   ───────────────────────────────────────────────────────────────────────── */
[data-skin="dark"] {
  --color-app: #0a0a0a;           /* Wayland --bg-base, verbatim */
  --color-panel: #171717;         /* sidebar ≈ Wayland --workspace-btn-bg */
  --color-card: #1f1f1f;          /* the content plane ≈ Wayland --bg-1 */
  --color-inset: #121212;         /* a hole, not a tile: one step under the card */
  --color-raised: #2a2a2a;        /* Wayland --bg-2, verbatim */
  --color-raised-hover: #353535;  /* Wayland --bg-3, verbatim */
  --color-control: #2a2a2a;       /* = raised: dark needs no separate tone */
  --color-hairline: #4d4d4d;      /* Wayland --border-base — edges on purpose */

  --color-ink: #f5f5f5;           /* Wayland --text-primary */
  --color-ink-secondary: #a8a8a8; /* between Wayland --text-muted and
                                     --text-secondary; matches the weight
                                     Midnight's #fcfcfc99 actually rendered */

  --color-accent: #ff6b35;        /* Forge Orange, unmodified */
  --color-accent-border: #ff8255; /* Wayland --brand-hover */
  --color-accent-text: #ff8255;   /* links on the ground — 8.09:1 on app */
  --color-focus: #ff8255;         /* the ring rides the accent */
  --color-accent-ink: #2a1207;    /* 6.23:1 on the orange fill */
  --color-bubble-user: #33241a;   /* your own messages: the one warm surface */

  --color-success: #34d399;       /* Wayland --success, verbatim */
  --color-success-ink: #06231a;
  --color-danger: #f87171;        /* Wayland --danger, verbatim */
  --color-danger-ink: #2a0806;
  --color-warning: #fbbf24;       /* Wayland --warning, verbatim */
  --color-scrollbar: #5c5c5c;
  --color-ember-line: #f5f5f5;

  --font-sans: "Inter", -apple-system, BlinkMacSystemFont, "SF Pro Text",
    "Segoe UI", system-ui, sans-serif;
  --radius-lg: 8px;               /* Wayland --radius-button */
  --radius-xl: 12px;              /* Wayland --radius-card */
}
```

### 3.3 Light — paste-ready

Replaces `[data-skin="atelier"]`.

```css
/* ── Light ─────────────────────────────────────────────────────────────────
   Wayland's light neutral ramp, near-verbatim. Wayland paints the page white
   and the panels grey; Murage's surface contract requires the content card to
   be the brightest thing (--color-card must clear --color-app by 1.04:1), so
   the same rungs are assigned one step over: app = Wayland --bg-2,
   panel = --bg-1, card/raised = --bg-base.

   The accent is NOT Forge Orange. #ff6b35 measures 2.49:1 against this ground
   and carries white at 2.84:1; no light ground exists on which it reaches the
   3:1 WCAG 1.4.11 asks of a control boundary. It is stepped down to #b8481f
   (white ink 5.27:1, 4.62:1 on the ground) and the bright brand tone survives
   as --color-accent-border. Wayland's semantic greens/ambers/reds get the same
   treatment: theirs are decorative fills, Murage renders them as text.
   ───────────────────────────────────────────────────────────────────────── */
[data-skin="light"] {
  --color-app: #f0f0f0;           /* Wayland --bg-2 — the outermost ground */
  --color-panel: #f7f7f7;         /* Wayland --bg-1 — sidebar */
  --color-card: #ffffff;          /* Wayland --bg-base — the content plane */
  --color-raised: #ffffff;        /* = card: raised means brighter here */
  --color-inset: #eaeaea;         /* a hole: one step under the card */
  --color-raised-hover: #e5e5e5;  /* Wayland --bg-3 / --bg-active */
  --color-control: #d4d4d4;       /* Wayland --bg-4. raised is white and so is
                                     a card, so a control on a card needs its
                                     own tone: 1.48:1 there, and it still
                                     clears the panel, the ground, an inset row
                                     and the hover fill */
  --color-hairline: #bfbfbf;      /* Wayland --border-bright. --border-base
                                     (#d4d4d4) only reaches 1.30:1 on this
                                     ground, under the 1.5 floor */

  --color-ink: #0d0d0d;           /* Wayland --text-primary */
  --color-ink-secondary: #555555; /* Wayland --text-dim. --text-muted (#777)
                                     is 3.77:1 on the hover fill — fails */

  --color-accent: #b8481f;        /* Forge Orange stepped down between Wayland
                                     --primary-8 and --primary-9 */
  --color-accent-border: #cc5529; /* Wayland --primary-8 — the bright edge */
  --color-accent-text: #a83c14;   /* links on a light ground — 6.32:1 on white */
  --color-focus: #b8481f;         /* the ring rides the accent */
  --color-accent-ink: #ffffff;    /* 5.27:1 on the fill */
  --color-bubble-user: #ffe6db;   /* Wayland --brand-light / --aou-1 */

  --color-success: #0f7a52;       /* Wayland #34d399 is 1.6:1 on white */
  --color-success-ink: #ffffff;
  --color-danger: #b3261e;        /* Wayland #f87171 is 2.9:1 on white */
  --color-danger-ink: #ffffff;
  --color-warning: #8a6100;       /* Wayland #fbbf24 is 1.6:1 on white */
  --color-scrollbar: #b3b3b3;     /* Wayland --bg-5 */
  --color-ember-line: #555555;

  --font-sans: "Inter", -apple-system, BlinkMacSystemFont, "SF Pro Text",
    "Segoe UI", system-ui, sans-serif;
  --radius-lg: 8px;
  --radius-xl: 12px;
}
```

### 3.4 Why the light accent had to move — the arithmetic

Relative luminance of `#ff6b35` is **0.3204**. For a foreground/background pair
to reach 3:1 the lighter of the two must satisfy `(L+0.05) ≥ 3 × (l+0.05)`.
With the orange as the *darker* member, the ground would need
`L ≥ 3 × 0.3704 − 0.05 = 1.061` — brighter than white, so impossible. With the
orange as the *lighter* member, the ground needs `l ≤ 0.3704/3 − 0.05 = 0.0735`,
i.e. darker than about `#4c4c4c`. **There is no light ground on which brand
orange is a legal control boundary.** The only remaining choice is how far down
to step it.

Candidates measured (white ink on the fill / fill against `--color-app #f0f0f0`):

| Hex | white ink | on `#f0f0f0` | Verdict |
| --- | --- | --- | --- |
| `#ff6b35` (Wayland `--brand`) | 2.84 | 2.49 | fails both |
| `#cc5529` (Wayland `--primary-8`) | 4.29 | 3.76 | fails AA on ink |
| `#c2521f` | 4.65 | 4.08 | passes, no headroom |
| **`#b8481f` (chosen)** | **5.27** | **4.62** | passes with headroom |
| `#99401e` (Wayland `--primary-9`) | 6.76 | 5.93 | passes; reads brown |

`#b8481f` is the brightest value with real headroom on both axes. It is still
unmistakably orange next to `#cc5529` on the border.

### 3.5 Measured contrast — all 51 pairs

The repo's 37 pairs plus 14 I added (marked `+`). Threshold in brackets.
Ratios computed with the same WCAG 2.x relative-luminance formula
`check-skin-contrast.mjs` uses, on the exact hexes above.

| Pair | Need | **Dark** | **Light** |
| --- | --- | --- | --- |
| ink on app | 4.5 | 18.16 | 17.05 |
| ink on panel | 4.5 | 16.44 | 18.14 |
| ink on raised | 4.5 | 13.17 | 19.44 |
| ink on raised-hover | 4.5 | 11.25 | 15.43 |
| ink on card | 4.5 | 15.12 | 19.44 |
| ink on inset | 4.5 | 17.18 | 16.16 |
| ink-secondary on app | 4.5 | 8.33 | 6.54 |
| ink-secondary on panel | 4.5 | 7.54 | 6.96 |
| ink-secondary on raised | 4.5 | 6.04 | 7.46 |
| **ink-secondary on raised-hover** | 4.5 | **5.16** | **5.92** |
| ink-secondary on card | 4.5 | 6.93 | 7.46 |
| ink-secondary on inset | 4.5 | 7.88 | 6.20 |
| ink on bubble-user | 4.5 | 13.68 | 16.28 |
| + ink-secondary on bubble-user | 4.5 | 6.27 | 6.25 |
| **accent-ink on accent** | 4.5 | 6.23 | **5.27** |
| danger-ink on danger | 4.5 | 6.68 | 6.54 |
| success-ink on success | 4.5 | 8.65 | 5.35 |
| accent-text on app | 4.5 | 8.09 | 5.55 |
| accent-text on panel | 4.5 | 7.32 | 5.90 |
| accent-text on card | 4.5 | 6.73 | 6.32 |
| + accent-text on raised | 4.5 | 5.86 | 6.32 |
| + accent-text on inset | 4.5 | 7.65 | **5.26** |
| danger on card | 4.5 | 5.96 | 6.54 |
| success on card | 4.5 | 8.57 | 5.35 |
| warning on card | 4.5 | 9.87 | 5.54 |
| + danger on app | 4.5 | 7.16 | 5.74 |
| + success on app | 4.5 | 10.30 | **4.69** |
| + warning on app | 4.5 | 11.86 | **4.86** |
| hairline on app | 1.5 | 2.34 | **1.61** |
| + hairline on panel | 1.5 | 2.12 | 1.72 |
| + hairline on card | 1.5 | 1.95 | 1.84 |
| + hairline on raised | 1.5 | **1.70** | 1.84 |
| accent on app | 3 | 6.98 | **4.62** |
| + accent on panel | 3 | 6.32 | 4.92 |
| + accent on card | 3 | 5.81 | 5.27 |
| scrollbar on app | 1.5 | 2.96 | 1.84 |
| focus on app | 3 | 8.09 | 4.62 |
| focus on panel | 3 | 7.32 | 4.92 |
| focus on card | 3 | 6.73 | 5.27 |
| + focus on raised | 3 | 5.86 | 5.27 |
| + focus on inset | 3 | 7.65 | **4.38** |
| + ember-line on app | 3 | 18.16 | 6.54 |
| control on card | 1.06 | **1.15** | 1.48 |
| control on panel | 1.06 | 1.25 | 1.38 |
| control on app | 1.04 | 1.38 | 1.30 |
| control on inset | 1.04 | 1.31 | 1.23 |
| control on raised-hover | 1.04 | **1.17** | **1.18** |
| raised-hover on card | 1.04 | 1.34 | 1.26 |
| inset on card | 1.04 | 1.14 | 1.20 |
| card on app | 1.04 | 1.20 | 1.14 |
| panel on app | 1.03 | **1.10** | **1.06** |

**No pair in either palette falls below its bar.** Worst cases:

- **Dark** — worst text pair **5.16:1** (`ink-secondary` on `raised-hover`);
  worst non-text indicator **5.81:1**; tightest surface step **1.10:1**
  (panel/app, floor 1.03).
- **Light** — worst text pair **4.62:1**\* (`accent` used as text is not a case
  that occurs; the true worst *text* pair is **5.26:1**, `accent-text` on
  `inset`); worst non-text indicator **4.38:1** (`focus` on `inset`); tightest
  surface step **1.06:1** (panel/app, floor 1.03).

  \* `accent on app 4.62` is measured against a 3:1 bar because it is a fill
  boundary, not text; it clears 4.5 anyway.

Two additional pairs, not in the table because they exercise the disabled-button
rule at the foot of `styles.css` (`background: raised-hover; color:
ink-secondary`), are the same `ink-secondary on raised-hover` measurement —
**5.16 dark / 5.92 light**, both clear. §9.3 adds it to the script explicitly so
that fact is enforced rather than noticed.

### 3.6 Verification performed

A scratch `styles.css` containing only the `@theme`, `:root`, `[data-skin="dark"]`
and `[data-skin="light"]` blocks above was fed to a copy of
`scripts/check-skin-contrast.mjs` with only the `root` path redirected —
parser, pair list, thresholds and baseline logic untouched:

```
✓ dark — 37 pairs, none below target
✓ light — 37 pairs, none below target
exit=0
```

The extra 14 pairs were measured with the same functions lifted from that
script. Nothing here is asserted from a screenshot.

---

## 4. Naming

**Endorsed: `Light`, `Dark`, `Automatic`.** Not because plain names are safe,
but because the poetic names were doing a job that no longer exists.

"Midnight", "Atelier", "Foundry", "Lagoon" earned their keep when a user faced
four options that differed by *character* rather than by brightness — a name is
the only thing that can tell you Foundry is warm and Lagoon is cool before you
click. With two palettes that differ **only** by brightness, the name has one bit
to carry and "Light"/"Dark" carry it instantly. Any alternative has to be
*faster to understand* than the plain word, and no candidate clears that bar:
"Daylight/Nightfall" is a synonym with an extra syllable; "Paper/Ink" makes you
map a metaphor; keeping "Atelier/Midnight" makes you remember which is which
forever.

Specifics:

- **`Automatic`, not `System` or `Auto`.** "System" invites the question *which*
  system; "Auto" is an abbreviation of a word that is already short. Wayland
  labels it "Auto" — a reasonable choice in a 280 px pill, but Murage's card has
  room and "Automatic" is a real word.
- **Stored ids `"light"`, `"dark"`, `"auto"`.** The stored value is a key, not
  prose; `"auto"` is conventional in this position (it is what Wayland's own
  `ThemePreference` calls `'system'`, and what CSS calls `auto` everywhere else).
- **Drop the taglines.** `Skin.tagline` exists to disambiguate four moods. "The
  original. Cool and dark." under a button labelled *Dark* is noise. The one
  sentence worth keeping is a caption on the whole control, not per option —
  see §7.3.
- **The settings card is titled "Appearance", not "Skin".** "Skin" is a
  1999 winamp word and, after this change, a lie: there are no skins, there is a
  theme.

---

## 5. Automatic

Automatic is a **preference**, not a palette. There is no `[data-skin="auto"]`
block and there never should be — a third block would be a third palette to keep
in contrast, and `data-skin="auto"` would leave every consumer of that attribute
(the picker's `active` state, `skinChrome()`, the miniature trick) unable to say
what colour anything is.

### 5.1 The two-layer model

```
  preference   "light" | "dark" | "auto"   ← what the user chose, persisted
       │
       │  resolve(preference) = preference === "auto"
       │       ? (matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light")
       │       : preference
       ▼
  resolved     "light" | "dark"            ← what is stamped on <html data-skin>
```

`SkinId` narrows to `"light" | "dark"` and keeps meaning "a palette that
exists in CSS". A new `ThemePreference = SkinId | "auto"` is what the picker
edits and what `localStorage` holds.

### 5.2 `src/lib/skins.ts` — the shape

```ts
export const SKIN_IDS = ["light", "dark"] as const;
export type SkinId = (typeof SKIN_IDS)[number];

export const THEME_PREFERENCES = ["light", "dark", "auto"] as const;
export type ThemePreference = (typeof THEME_PREFERENCES)[number];

export const DEFAULT_PREFERENCE: ThemePreference = "auto";
/** The palette a renderer with no matchMedia falls back to. */
export const DEFAULT_SKIN: SkinId = "dark";

const KEY = "murage-skin";
const DARK_QUERY = "(prefers-color-scheme: dark)";

/** The OS setting, or DEFAULT_SKIN where it cannot be asked. */
export function systemSkin(): SkinId {
  try {
    if (typeof window === "undefined" || typeof window.matchMedia !== "function") {
      return DEFAULT_SKIN;
    }
    return window.matchMedia(DARK_QUERY).matches ? "dark" : "light";
  } catch {
    return DEFAULT_SKIN;
  }
}

export function resolveSkin(preference: ThemePreference): SkinId {
  return preference === "auto" ? systemSkin() : preference;
}

export function readPreference(): ThemePreference { /* §6 */ }
export function writePreference(p: ThemePreference): void { /* §6 */ }

/** Stamp the resolved palette and mirror it to the native chrome. */
export function applySkin(id: SkinId): void { /* unchanged body */ }

/** Persist a preference and paint its resolution. */
export function applyPreference(p: ThemePreference): SkinId {
  const id = resolveSkin(p);
  writePreference(p);
  applySkin(id);
  return id;
}

/**
 * Follow the OS while the preference is "auto". Returns an unsubscribe.
 * Registered once at module scope from main.tsx, NOT inside a component —
 * the theme must keep tracking the OS whether or not Settings is mounted.
 */
export function watchSystemSkin(onChange: (id: SkinId) => void): () => void {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") {
    return () => {};
  }
  const mq = window.matchMedia(DARK_QUERY);
  const handler = () => {
    if (readPreference() === "auto") onChange(mq.matches ? "dark" : "light");
  };
  // Safari < 14 only has addListener; Electron does not need it, a browser
  // build might.
  if (typeof mq.addEventListener === "function") {
    mq.addEventListener("change", handler);
    return () => mq.removeEventListener("change", handler);
  }
  mq.addListener?.(handler);
  return () => mq.removeListener?.(handler);
}
```

Note the guard inside `handler`: it re-reads the preference rather than trusting
a captured value, so a listener registered once at startup cannot fight a user
who has since picked an explicit theme.

### 5.3 No flash of the wrong theme — three places, not one

`main.tsx` already calls `applySkin(readSkin())` before `createRoot`, and its
comment claims that is "before the first paint". **That is true of React's first
paint and false of the window's.** Three separate flashes are possible and all
three need closing:

1. **HTML → module gap.** `index.html` paints before `src/main.tsx` is fetched
   and evaluated. `body { background-color: var(--color-app) }` resolves against
   the `@theme` default, which is the *dark* palette — so a light user gets a
   black frame first. Fix: an inline, synchronous stamp in `index.html`'s
   `<head>`, before any stylesheet link:

   ```html
   <script>
     // Stamped before the stylesheet resolves, so the first painted frame is
     // already the right palette. Duplicates two lines of src/lib/skins.ts on
     // purpose: a module import here would reintroduce the gap it closes.
     try {
       var p = localStorage.getItem("murage-skin");
       var legacy = { midnight: "dark", foundry: "dark", atelier: "light", lagoon: "light" };
       p = legacy[p] || p;
       if (p !== "light" && p !== "dark") p = "auto";
       document.documentElement.dataset.skin =
         p === "auto"
           ? (matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light")
           : p;
     } catch (e) {
       document.documentElement.dataset.skin = "dark";
     }
   </script>
   ```

   This is a knowing duplication of the migration map (§6). §9.5 specifies the
   test that keeps the two copies identical, so the duplication cannot rot.

2. **Electron window background.** `electron/main.mjs:1373` hardcodes
   `backgroundColor: "#070707"` (and `:1078` for the desktop viewer). A light
   user gets a black rectangle for the whole load. Fix: persist the resolved
   theme in the file that already persists window state
   (`window-state.json`, `electron/main.mjs:115-145`) and read it at window
   creation:

   ```js
   const chrome = skinChrome(restored.skin ?? (nativeTheme.shouldUseDarkColors ? "dark" : "light"));
   // …
   backgroundColor: chrome.color,
   ```

   On a genuinely first run there is no stored value and `nativeTheme` answers
   correctly, so the very first frame is right too.

3. **OS flip while the app is running.** `watchSystemSkin` (§5.2), registered
   once from `main.tsx` at module scope:

   ```ts
   const initial = readPreference();
   applySkin(resolveSkin(initial));
   watchSystemSkin(applySkin);
   ```

   The picker, if mounted, needs to reflect the flip: it subscribes to the same
   helper in a `useEffect` and updates its `resolved` display state. The
   *preference* it shows does not change — Automatic stays selected.

### 5.4 The default for a brand-new user: **Automatic**

Recommended, with the reasoning stated so it can be argued with.

Wayland chose `dark` and documented why: "onboarding and the welcome flow pin a
dark palette, so 'system' would flip a light-mode OS to light the moment
onboarding ends, breaking visual consistency". **That reason does not transfer.**
Murage's onboarding (`src/components/Onboarding.tsx`) is built from the same
tokens as everything else — there is no pinned dark surface to be inconsistent
with. I checked: the only raw hex left in `src/` outside `styles.css` lives in
ten files, and they are the mascot palette (`mascot.ts`, `EmberAvatar.tsx`,
`Avatar.tsx`) and vendor brand marks (`ProviderIcons.tsx`, `HermesMark.tsx`) —
all of which are *supposed* to be theme-invariant.

The case for Automatic:

- It is the only default that is never wrong. A dark default is wrong for every
  light-mode user on first launch; Automatic is wrong for nobody, because it is
  by definition what the machine was already doing.
- **It costs no existing user anything.** Every current install has an explicit
  value in `murage-skin`, and §6 maps all four to an explicit `light` or `dark`.
  The new default reaches new installs only.
- It makes the third option discoverable. A user who never opens Settings still
  benefits from it; a user who does, sees it already selected and understands
  what it means without reading anything.

`DEFAULT_SKIN` stays `"dark"` but changes job: it is now only the fallback for a
renderer that cannot answer `matchMedia` (SSR, a locked-down browser context,
the Electron main process before a window exists). Dark is the right value there
because it matches the app's native window background.

---

## 6. Migration

Without this, deleting `foundry` and `lagoon` means `isSkinId()` returns false,
`readSkin()` returns `DEFAULT_SKIN`, and a Foundry user's app is a different
colour on Monday with no explanation. A Lagoon user — on a *light* skin — would
land on dark. That is the loudest possible version of the bug.

### 6.1 The map

| Stored value | Becomes | Why |
| --- | --- | --- |
| `"midnight"` | `"dark"` | dark → dark |
| `"foundry"` | `"dark"` | dark → dark; the owner disliked the brass, not the darkness |
| `"atelier"` | `"light"` | light → light |
| `"lagoon"` | `"light"` | light → light |
| `"light"` / `"dark"` / `"auto"` | unchanged | already migrated |
| anything else, or unreadable | `DEFAULT_PREFERENCE` (`"auto"`) | corrupt / hand-edited / first run |

Preserving *brightness* is the whole point. Nobody chose Foundry because it was
warm and Lagoon because it was cool as separable decisions — they chose a dark
app or a light one, and that is the bit that must survive.

### 6.2 Implementation — migrate on read, rewrite on read

```ts
/** Skins that no longer exist, mapped to the palette that preserves their
 *  brightness. Read-side only: a value written by any earlier build must land
 *  somewhere deliberate, not fall through to the default. Removing a row here
 *  silently re-themes everyone who was on that skin. */
const LEGACY_SKINS: Readonly<Record<string, SkinId>> = Object.freeze({
  midnight: "dark",
  foundry: "dark",
  atelier: "light",
  lagoon: "light",
});

function isPreference(value: unknown): value is ThemePreference {
  // SAFETY: the assertion only satisfies includes()' parameter type; the
  // check itself is what decides, and a non-member returns false.
  return THEME_PREFERENCES.includes(value as ThemePreference);
}

export function readPreference(): ThemePreference {
  try {
    const stored = getStore()?.getItem(KEY);
    if (isPreference(stored)) return stored;
    if (typeof stored === "string" && Object.hasOwn(LEGACY_SKINS, stored)) {
      const migrated = LEGACY_SKINS[stored];
      // Rewrite so the migration happens once, and so a later downgrade
      // cannot resurrect a skin id that no longer has a CSS block.
      writePreference(migrated);
      return migrated;
    }
    return DEFAULT_PREFERENCE;
  } catch {
    return DEFAULT_PREFERENCE;
  }
}
```

Two deliberate choices:

- **Same key, `murage-skin`.** A second key would leave the old one on disk
  forever as a decoy. Rewriting in place means the migration runs once per
  install and the storage is self-describing afterwards.
- **The rewrite is best-effort.** `writePreference` is already wrapped for
  quota/private-mode failures; if the write fails, the read still returns the
  right value and the migration simply runs again next launch.

The inline `index.html` script (§5.3) carries the same map. That duplication is
the price of a synchronous pre-stylesheet stamp, and §9.5 tests it.

---

## 7. What else changes

### 7.1 `src/styles.css`

- Delete `[data-skin="foundry"]` (~lines 179–226) and `[data-skin="lagoon"]`
  (~228–277).
- Rename `[data-skin="midnight"]` → `[data-skin="dark"]` and replace its body
  with §3.2. Rename `[data-skin="atelier"]` → `[data-skin="light"]` and replace
  with §3.3.
- **`@theme` defaults become the Dark values.** The block's comment currently
  says "Defaults = Midnight. Kept here so the app is never unstyled." Keep the
  mechanism, update the values and the sentence. Add `--radius-lg: 8px` and
  `--radius-xl: 12px` to `@theme` so they stop having no base declaration
  (§2.1).
- The `:root` block (accent/danger/success ink, scrollbar, ember-line) takes the
  Dark values.
- Rewrite the file-header comment: it names Atelier and Foundry as the skins
  that clear AA. Replace with the fact that both palettes now clear it, and keep
  the pointer to `scripts/check-skin-contrast.mjs`.
- **Delete the `BASELINE_FLOORS` entries** in that script — they exist solely to
  grandfather Midnight's two upstream gaps (`accent-ink on accent 3.65`,
  `danger-ink on danger 3.10`). With Midnight gone, a below-target pair is
  unambiguously a regression, and leaving dead baseline rows in place is an
  invitation to re-grandfather something later.

> `src/styles.css` is held by another agent as of writing. These are the only
> regions this change needs; the layout work elsewhere in the file is
> untouched by it.

### 7.2 `src/lib/skins.ts`

Full rewrite of the registry half; §5.2 and §6.2 give the bodies.
`applySkin()`'s own body — the `dataset.skin` stamp, the storage write, the
`window.muragebox?.applySkin?.()` bridge — is unchanged apart from taking a
`SkinId` that can now only be `"light"` or `"dark"`. Drop `Skin.tagline` (§4).
`SKINS` becomes:

```ts
export const SKINS: readonly Skin[] = [
  { id: "light", name: "Light" },
  { id: "dark", name: "Dark" },
];
```

### 7.3 `src/components/SkinPicker.tsx` — what it becomes

**It stays where it is.** It is not on its own settings screen today — it is a
`<Card title="Skin">` inside Settings → General (`SettingsModal.tsx:670`),
between Profile and Channel turns. That placement is correct and gets *more*
correct as the control shrinks: a three-option toggle is a settings row, not a
destination.

**Drop the miniatures.** They are the strongest thing in the current component
and they should still go. Their job is to let you judge four characters that a
name cannot convey. With two palettes the name conveys everything, and the
instant feedback is better than any preview — clicking Dark makes the entire
application the preview. Worse, **Automatic cannot be drawn**: any miniature for
it is either a lie (it shows one palette) or a puzzle (a half-and-half split the
user has to decode). A control with two honest thumbnails and one that shrugs is
worse than three plain labels.

**Reuse Wayland's interaction model** (`ThemeSwitcher.tsx`), which is good and
should not be reinvented: a single-row `role="radiogroup"` of three
`role="radio"` buttons, `aria-checked` on the active one, icon + label in each,
the active label in the accent. Take that, and drop the two pieces of it that
are decoration rather than information — the sliding indicator pill with its
`cubic-bezier` transition and the icon crossfade/rotate. Neither tells you
anything; both cost a `useState`-free layout calculation with hardcoded
`trackInset` / `splitGap` arithmetic.

Shape, against the design bar for this project:

```
┌─ Appearance ─────────────────────────────────────────────────┐
│  Applies instantly and is remembered on this machine.        │
│                                                              │
│  ┌──────────────┬──────────────┬──────────────┐              │
│  │  ☀  Light    │  ☾  Dark     │  ◐ Automatic │              │
│  └──────────────┴──────────────┴──────────────┘              │
│  Following your system — currently Dark.                     │
└──────────────────────────────────────────────────────────────┘
```

- **Order: Light, Dark, Automatic.** The owner's own phrasing, and it reads as
  "one, the other, or let the machine decide". (Wayland puts Auto first; that
  suits a compact pill in a toolbar, not a labelled settings row.)
- **Three equal columns**, `grid-cols-3`, one `gap` value, one `border` on the
  group rather than three on the segments — so the dividers are hairlines
  between cells and the outer edge is a single rounded rectangle. Level and
  parallel by construction, not by nudging.
- **Sizing chosen, not inherited**: 36 px row height, 14 px icon, 13 px label,
  12 px horizontal padding, `--radius-lg` on the group. Icons and labels share
  one baseline; the icon is optically centred against cap height, not the em box.
- **Selected state**: `bg-control` fill, `border-accent-border`, label in
  `text-accent-text`. Unselected: transparent, `text-ink-secondary`,
  `hover:bg-control/50`. No shadow — Wayland's `0 1px 4px rgba(0,0,0,.15)` on
  the pill is invisible in dark mode and muddy in light.
- **The caption line is the only thing Automatic needs that the others don't**,
  and it is the one fact the control cannot show: which way Automatic currently
  resolves. Render it only when `preference === "auto"`, in `text-ink-secondary`
  at 11–12 px, and update it live from the `watchSystemSkin` subscription. When
  the preference is explicit, render nothing there — do not reserve the space
  with an empty line; let the card be shorter.
- **Keyboard**: `role="radiogroup"` means arrow keys move the selection and
  Tab enters/leaves the group as one stop. This is the accessibility reason to
  use radios rather than three `aria-pressed` buttons, which is what the current
  component does.

### 7.4 Electron

**`electron/skin-overlay.cjs`** — `SKIN_CHROME` becomes:

```js
const SKIN_CHROME = Object.freeze({
  dark: Object.freeze({ color: "#0a0a0a", symbolColor: "#a8a8a8" }),
  light: Object.freeze({ color: "#f0f0f0", symbolColor: "#555555" }),
});
const DEFAULT_SKIN = "dark";
```

Values mirror each palette's `--color-app` and `--color-ink-secondary`, per the
module's existing contract. `skinChrome()` and `isKnownSkin()` are unchanged.

**`electron/main.mjs`** —

- `backgroundColor: "#070707"` → the resolved chrome colour, at both `:1078`
  (desktop viewer) and `:1373` (main window). See §5.3 item 2.
- The `desktop:skin` handler (`:1663`) must reject `"auto"` — the renderer sends
  the *resolved* id, never the preference. `isKnownSkin("auto")` already returns
  false, so this is a documentation point, not a code change: state it in the
  handler comment, because a future caller passing the preference through would
  silently get dark chrome on a light OS (`skinChrome` falls back to
  `DEFAULT_SKIN` on anything unknown).
- Persist the resolved id into `window-state.json` alongside `bounds` and
  `maximized` so the next cold start opens with the right frame.
- **Fix the pre-existing Windows hang (§0.3)**: either have the `desktop:skin`
  handler call `win.show()` on the first handshake, or — simpler, given that
  Murage deliberately does not use `titleBarOverlay` on Windows — delete
  `waitsForSkinSync`, `show: !waitsForSkinSync` and the `skinSyncFallback`
  timer, and let the window show immediately with a correct
  `backgroundColor`. **I recommend deleting them.** The mechanism exists to
  cover a caption-button overlay that this app does not create; once
  `backgroundColor` is theme-correct there is nothing left for it to hide.

**`electron/preload.cjs:128`** — unchanged.

### 7.5 Complete file list

| File | Change |
| --- | --- |
| `src/styles.css` | delete two blocks, rename + replace two, retarget `@theme` / `:root` defaults, add radii to `@theme`, rewrite header comment |
| `src/lib/skins.ts` | `SKIN_IDS`, `ThemePreference`, `LEGACY_SKINS`, `resolveSkin`, `systemSkin`, `watchSystemSkin`, `readPreference`/`writePreference`, drop `tagline` |
| `src/lib/skins.test.ts` | §9.1–9.2 |
| `src/main.tsx` | resolve preference, register `watchSystemSkin` at module scope |
| `index.html` | inline pre-paint stamp (§5.3) |
| `src/components/SkinPicker.tsx` | rewrite as a 3-option radiogroup (§7.3) |
| `src/components/SettingsModal.tsx:670` | card title `"Skin"` → `"Appearance"`, subtitle updated |
| `scripts/check-skin-contrast.mjs` | drop `BASELINE_FLOORS`, add the 14 pairs from §3.5 + the disabled pair (§9.3) |
| `electron/skin-overlay.cjs` | new `SKIN_CHROME`, new `DEFAULT_SKIN` |
| `electron/skin-overlay.test.mjs` | ids follow; §9.4 |
| `electron/main.mjs` | `backgroundColor` ×2, window-state field, `desktop:skin` comment, Windows show path |
| **new** `src/lib/tokens.test.ts` | token-drift guard (§8) |

`src/types/muragebox.d.ts:193` types `applySkin?(skin: string)` — no change
needed. Nothing else in `src/`, `server/`, `companion/` or `public/` references a
skin id. (`server/skills.test.ts:128` contains the literal string
`foundry-skills` in a YAML fixture — unrelated, do not touch it.)

---

## 8. The token-drift guard — port it, as a test

**Agreed, and yes it belongs in vitest rather than a git hook.** The repo runs
`vitest run` in `pnpm test` and has no husky config; a hook would be a second,
weaker enforcement path that CI does not see.

But it should not be a transliteration of `check-ui-tokens.js`. That script is
shaped around Wayland's problem: hand-written `var(--token)` references in
`.tsx`, where a typo yields an undefined custom property and a browser default.
Murage's shape is different — the whole of `src/` contains exactly **9**
`var(--color-…)` sites; the real surface is **~3,000 Tailwind utility class
names** (`text-ink-secondary` × 790, `text-ink` × 606, `border-hairline` × 329,
`bg-raised` × 271, …). Under Tailwind v4 a utility whose token does not exist
does not error — the class is simply never generated, the element gets no
background, and the page renders wrong in silence. Same failure mode, different
door.

I ran the equivalent scan over `src/` today: **no drift exists right now.** The
guard is prophylactic, and cheap enough to be worth it.

**`src/lib/tokens.test.ts`** — four assertions, all parsing `src/styles.css`:

1. **Every palette defines every base token.** Reference set = the union of
   `@theme` and `:root` declarations (**not** `tokensOf(DEFAULT_SKIN)` — that is
   the hole from §2.1). Fails today's `--color-focus` omission, which is exactly
   the point.
2. **Every palette defines the same set as every other palette**, in both
   directions, so a token added to one and forgotten in the other is caught even
   if the base does not mention it (this is what would catch `--radius-lg`).
3. **Every colour utility used in `src/**/*.tsx` names a defined token.** Scan
   for `\b(bg|text|border|ring|ring-offset|fill|stroke|outline|divide|caret|placeholder|accent|from|to|via|shadow)-([a-z][a-z0-9-]*)\b`,
   drop Tailwind's own scale words and palette names, assert the remainder
   exists as `--color-<name>`. Longest-match first, so `ring-offset-app` is not
   parsed as `ring-offset` + a bare word. Keep the ignore list in the test file
   with a comment per entry, the way `check-ui-tokens.js` documents its
   `HEX_ALLOWLIST`.
4. **No raw hex outside the allowlist.** Ten files legitimately carry hex:
   `src/styles.css`, `src/lib/mascot.ts`, `src/components/EmberAvatar.tsx`,
   `Avatar.tsx`, `ProviderIcons.tsx`, `HermesMark.tsx`, `CursorMark.tsx`,
   `Sidebar.tsx`, `RoutineCalendarPage.tsx`, `PhoneSetupFlow.tsx`,
   `LocalVmWorkspace.tsx`. Mascot and vendor marks are deliberately
   theme-invariant; the last four should be inspected during this change and
   either tokenised or given a one-line reason in the allowlist. Warning-only in
   Wayland; here, make it a **failing assertion with an explicit allowlist**,
   because an allowlist someone must edit is a decision and a warning nobody
   reads is not.

Do **not** port the `BANNED_TOKENS` table — it encodes Wayland's specific
historical typos and has no meaning in a codebase with different token names.

---

## 9. Test plan

The repo's standard: a test nobody has seen fail is not a test. For each, the
revert that must turn it red.

### 9.1 Registry ↔ stylesheet (extend `src/lib/skins.test.ts`)

```
it("gives every registered skin a stylesheet block")   — exists, keep
it("registers every stylesheet block")                  — exists, keep
it("defines every base token in every skin")            — REPLACES the current
                                                          "same tokens in every skin"
it("describes each skin exactly once")                  — exists, drop the tagline assertion
```

**Fails when reverted?** Yes, three ways, all observed by construction:
leaving `[data-skin="lagoon"]` in the CSS fails "registers every stylesheet
block"; renaming the block to `dark` but not `SKIN_IDS` fails "gives every
registered skin a block"; and changing the reference from the base back to
`tokensOf(DEFAULT_SKIN)` makes the suite pass with `--color-focus` missing from
`light` — which is the current, demonstrable hole.

### 9.2 Migration (new, in `src/lib/skins.test.ts`)

```ts
describe("migration from the four-skin era", () => {
  it.each([
    ["midnight", "dark"],
    ["foundry", "dark"],
    ["atelier", "light"],
    ["lagoon", "light"],
  ])("maps a stored %s to %s", (stored, expected) => {
    localStorage.setItem("murage-skin", stored);
    expect(readPreference()).toBe(expected);
  });

  it("rewrites storage so the migration runs once", () => {
    localStorage.setItem("murage-skin", "lagoon");
    readPreference();
    expect(localStorage.getItem("murage-skin")).toBe("light");
  });

  it.each(["light", "dark", "auto"])("leaves a current preference alone", (p) => {
    localStorage.setItem("murage-skin", p);
    expect(readPreference()).toBe(p);
  });

  it("falls back to Automatic for a value from nowhere", () => {
    localStorage.setItem("murage-skin", "chartreuse");
    expect(readPreference()).toBe("auto");
  });

  it("survives storage that throws", () => {
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new DOMException("denied", "SecurityError");
    });
    expect(readPreference()).toBe("auto");
  });
});
```

**Fails when reverted?** Yes, and this is the highest-value test in the set.
Delete the `LEGACY_SKINS` lookup from `readPreference` and all four `it.each`
rows go red immediately, because the fallback returns `"auto"` where the test
demands `"dark"` / `"light"`. Change one row of the map (say `lagoon: "dark"`)
and exactly one row fails, naming the user population that would have been
re-themed. Note the assertions are written **against the mapping table, not
against the implementation** — an implementation that special-cases `midnight`
and forgets `foundry` fails one row and passes the rest.

### 9.3 Contrast (`scripts/check-skin-contrast.mjs`, run by `pnpm check:contrast`)

- Remove the two `BASELINE_FLOORS` rows.
- Add the 14 pairs marked `+` in §3.5 (`hairline` on panel/card/raised,
  `focus` on raised/inset, `accent` on card/panel, `accent-text` on
  raised/inset, `ink-secondary` on bubble-user, `danger`/`success`/`warning` on
  app, `ember-line` on app at 3:1).
- Add the disabled-button pair explicitly, with the comment naming the rule at
  the foot of `styles.css` that produces it:
  `["--color-ink-secondary", "--color-raised-hover", 4.5]` — already present via
  the `SURFACES` fan-out, so instead add a comment there rather than a duplicate
  row, and add the pair the fan-out misses:
  `["--color-ink", "--color-control", 4.5]` (labels on a control chip).
- **Wire it into `pnpm test`.** It is currently a separate script that CI may or
  may not run; a palette change that fails contrast should fail the same command
  everything else fails.

**Fails when reverted?** Yes, verifiably: substituting `#ff6b35` for the light
palette's `--color-accent` makes `accent on app` report `2.49:1 (needs 3:1)` and
`accent-ink on accent` report `2.84:1 (needs 4.5:1)`, and the script exits 1.
That is the exact regression §3.4 exists to prevent, and it is reachable in one
edit by anyone who decides the brand orange should be "consistent".

### 9.4 Native chrome (`electron/skin-overlay.test.mjs`)

The existing test already derives its skin list from `SKIN_IDS` in
`src/lib/skins.ts` filtered by presence in `styles.css`, and asserts each
chrome colour matches that skin's `--color-app`. It therefore follows the rename
for free — but only if `SKIN_CHROME` is updated. Keep the existing
`skinChrome("does-not-exist")` and `skinChrome(null)` fallback cases and **add**:

```js
it("refuses a preference where a palette is required", () => {
  expect(isKnownSkin("auto")).toBe(false);
  expect(skinChrome("auto")).toEqual(SKIN_CHROME.dark);
});
```

**Fails when reverted?** Yes — adding an `auto` key to `SKIN_CHROME` (the
obvious wrong fix if someone pipes the preference through the IPC) fails both
assertions, and the first one fails loudly rather than quietly painting a dark
titlebar on a light desktop.

### 9.5 The duplicated migration map (new, in `src/lib/tokens.test.ts` or beside 9.2)

```ts
it("keeps index.html's pre-paint stamp in step with skins.ts", () => {
  const html = readFileSync(join(root, "index.html"), "utf8");
  for (const [legacy, target] of Object.entries(LEGACY_SKINS)) {
    expect(html).toMatch(new RegExp(`${legacy}\\s*:\\s*"${target}"`));
  }
  expect(html).toContain("prefers-color-scheme: dark");
});
```

**Fails when reverted?** Yes. Add a fifth legacy id to `skins.ts` and forget the
HTML, and it goes red naming the missing id — which is exactly the failure that
would otherwise show up as "one black frame on launch for users of the skin you
just retired", i.e. never in a test and always in a bug report.

### 9.6 Automatic (new, in `src/lib/skins.test.ts`)

```ts
it("resolves auto from the OS", () => {
  matchMediaMock(true);  expect(resolveSkin("auto")).toBe("dark");
  matchMediaMock(false); expect(resolveSkin("auto")).toBe("light");
});

it("ignores the OS once a theme is chosen", () => {
  matchMediaMock(true);
  expect(resolveSkin("light")).toBe("light");
});

it("falls back to dark where matchMedia does not exist", () => {
  vi.stubGlobal("matchMedia", undefined);
  expect(resolveSkin("auto")).toBe("dark");
});

it("stops following the OS after the user picks a theme", () => {
  const mq = matchMediaMock(false);
  const seen: string[] = [];
  watchSystemSkin((id) => seen.push(id));
  localStorage.setItem("murage-skin", "light");   // user picked Light
  mq.emit(true);                                   // OS went dark
  expect(seen).toEqual([]);                        // preference wins
});
```

**Fails when reverted?** Yes for the last one, which is the subtle one: drop the
`readPreference() === "auto"` guard inside `watchSystemSkin`'s handler — the
plausible simplification, since the listener "is only registered for auto" — and
the app starts overriding an explicit choice the moment the OS flips. The test
records `["dark"]` and fails.

### 9.7 Manual, once — the things no unit test sees

1. Cold-launch on macOS in light mode with empty storage. **No black frame at
   any point.** (This is the flash `index.html` + `backgroundColor` fix.)
2. With Automatic selected, flip the OS theme via System Settings while the app
   is open and the Settings modal is on screen. The app repaints and the caption
   line under the control changes from "currently Light" to "currently Dark";
   the Automatic segment stays selected.
3. Windows cold start: window appears immediately, not after ~5 s (§0.3).
4. Tab into the Appearance control and drive it with arrow keys only.
5. One pass over a filled accent button, a filled danger button, a disabled
   accent button, the composer field, a selected sidebar row and a focus ring —
   in both palettes — since those are the six places the tokens interact rather
   than merely exist.

---

## Appendix — method

Ratios use the WCAG 2.x relative-luminance formula (sRGB, `0.2126 R + 0.7152 G +
0.0722 B` on linearised channels, `(L₁+0.05)/(L₂+0.05)`), which is the formula
`scripts/check-skin-contrast.mjs` implements; the numbers in §3.5 came from that
script's own functions, applied to the hexes in §3.2 and §3.3, and the 37-pair
subset was additionally verified by running an unmodified copy of the script
against a scratch stylesheet containing only these two blocks. No value in this
document was estimated, sampled from a screenshot, or rounded toward its
threshold. Where a pair sits close to its bar it is bolded in the table.
