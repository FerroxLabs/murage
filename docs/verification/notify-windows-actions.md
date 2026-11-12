# Windows banner actions: implementation and qualification

The Windows adapter is connected to the existing native notification seam.
It does not enable production actions: the OS envelopes in
`shared/outside-limits.mjs` remain zero pending S0 measurements. Open-only
behavior is an interim state, not completion of the Notify release scope.

`createWindowsBanners` is exported from `electron/approval-notification.mjs`.
Its implementation builds an escaped three-field toast containing the bot
name, title and complete detail, with foreground Allow, Deny and Reply
buttons. Reply uses the `reply` input. Activation arguments contain only a
random action token and an action letter. Unknown tokens, including tokens
from previous launches, have no effect.

All notification controllers share one `Notification.handleActivation`
subscription. This preserves local and Cloud Open-only navigation alongside
actionable banners. Custom XML activation uses `arguments` and
`userInputs.reply`, as documented in Electron's
[ActivationArguments](https://www.electronjs.org/docs/latest/api/structures/activation-arguments).
The installed Electron version still needs real Windows confirmation of this
input contract; API documentation and injected tests do not qualify S0.

The adapter calls `attentionActions.act` with the token minted against the
transport and identity captured with the card read. It never resolves a new
home or posts an answer itself. The action path retains the existing lock,
privacy, digest, single-use and transport guards. Native failure, Open,
settlement and disposal withdraw the native route and invalidate its token.
An OS timeout retains the route for a later Action Centre activation.

Portable regression tests:

```sh
node --test electron/windows-banners.node-test.mjs \
  electron/approval-notification.node-test.mjs \
  electron/global-shortcut-wiring.node-test.mjs \
  electron/native-banner-approvals.node-test.mjs \
  electron/attention-actions*.node-test.mjs
```

Run these in an isolated test container. The tests inject native callbacks
and transports; they do not establish actual banner layout or OS behavior.

Before enabling or qualifying release:

- Supply S0 measurements on macOS 14/15/26, Windows 10 22H2 and 11 24H2,
  Ubuntu 24.04 GNOME X11/Wayland, and Fedora KDE 6 Wayland. Include all 95
  printable ASCII glyph advances, usable width, line height, largest text
  size, narrowest collapsed layout, adversarial wrapping and all fields at
  their maxima. Measure the menu detail template as well.
- Implement the reviewed runtime layout qualification and revision binding,
  including unknown-layout refusal and invalidation when layout changes.
  Only then install measured envelopes and prove their boundaries.
- Integrate the No limits ONE RULE prerequisite. This base has no
  `finalDecision`; `answerOutside` must route banner Allow through that
  authoritative decision before `answerRequest`, preserving the existing
  synchronous checks. Do not add a separate banner policy. Require its
  inventory test, owner deny/wipe cases, other-level/non-owner parity and
  mandated replay evidence before enabling actions.
- On the resulting installed packages, prove Allow executes once, Deny and
  Reply reach the bot, settlement removes Action Centre entries, and stale,
  reused, locked, privacy-hidden and changed-layout activations cannot
  approve. Repeat captured Cloud transport and session replacement cases.
- Obtain independent review and the applicable packaged-platform gates.

No Mac was accessed and no real-platform qualification is claimed by this
source change.
