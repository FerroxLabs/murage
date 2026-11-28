You are an independent senior reviewer cross-auditing a design spec before implementation starts.

READ-ONLY. Do not modify any file, do not run builds (no cargo, pnpm build/install, gradle, xcodebuild), do not start servers. Only read files, grep, and git log/show.

Repository (current working directory): Murage, a self-hosted AI-agent workspace (Electron desktop + React web UI in src/ + node server in server/ + companion/ sidecar that serves the web UI to remote browsers behind `tailscale serve`). Branch mobile/v1.

Spec under review: docs/superpowers/specs/2026-09-25-murage-mobile-design.md — read it fully first.
Reference (older, parts-only Codex branch, may read): /Volumes/Fixture/workspace/muragemobile/integration-20260922 (apps/mobile, cloudflare/control-plane/src/mobile-notification*, server/mobile-notification-*).

Your job: find what is WRONG, MISSING, RISKY or OVER-SCOPED in the spec. Verify claims against the code (it cites files like companion/src/browser.ts, devices.ts, routes.ts, proxy.ts, server/index.ts notify(), src/state/store.tsx openNotificationTarget, src/lib/live-events.ts). Specifically pressure-test:
1. The core architecture: Capacitor WebView loading the remote host origin (https://<host>.ts.net → tailscale serve :443 → browser door :8813) with a native bridge. Is the Capacitor bridge actually available to a remotely navigated origin on iOS and Android in Capacitor 8? Security of exposing the bridge to that origin; is "exact origin only, main frame only" enforceable in Capacitor?
2. Auth: cookie session reuse in WKWebView/Android WebView, the proposed 5-minute rotation grace, the push-action token for lock-screen Approve/Deny (scope, storage, replay, revocation), step-up for risky approvals.
3. Push: content-free relay + iOS Notification Service Extension fetching detail from the host over Tailscale (does an NSE have network access over the Tailscale VPN? time limits ~30s? memory limits?), anonymous per-installation enrolment (abuse/spam risk to the relay), APNs/FCM specifics, stale-notification replacement.
4. Performance claims and fixes (brotli in companion, React.lazy splits, caching). Anything missing?
5. App Store / Play review risks (4.2 minimum functionality, 4.2.3, 2.5.2 remote code, demo mode, privacy labels).
6. Error handling and lifecycle holes (WebView process kill, cookie loss, multiple workspaces, host version skew between app and host — e.g. old host without /healthz or new bridge-aware UI).
7. Build order and scope: is V1 too big or missing something essential? Anything that should move between V1/V1.1?

Output format (markdown):
## Verdict
One of: APPROVE / APPROVE WITH CHANGES / REJECT, with one-paragraph rationale.
## Findings
Numbered, ranked by severity (Critical/High/Medium/Low). Each: title, severity, evidence (file:line or doc URL), why it matters, concrete recommended change to the spec.
## Things the spec gets right
Short list.
Keep it under ~1500 words. Be specific; no generic advice.
