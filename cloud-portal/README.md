# Murage Cloud portal (cloud.murage.ai)

Next.js 15 app. Three jobs: show the plans, send the customer to Stripe checkout, show My Cloud.
It holds no keys and no user table. Accounts, the second factor, homes and billing all live in the
control plane (`cloudflare/control-plane`, Better Auth). The portal keeps the control-plane bearer
token in an HttpOnly `__Host-` cookie and calls the control plane from the server.

## Settings (server env)

| Name | Default | Meaning |
|---|---|---|
| `CP_URL` | `https://accounts.murage.ai` | Control plane base URL |
| `PORTAL_ORIGIN` | `https://cloud.murage.ai` | Exact site origin. WebAuthn is bound to it. Set the same value as `PORTAL_ORIGIN` on the control plane Worker. |
| `NEXT_PUBLIC_BILLING_PROVIDER` | `stripe` | Build fails for any other value |
| `CHECKOUT_REDIRECT_HOSTS` | `checkout.stripe.com,billing.stripe.com` | The only hosts the portal will redirect to |
| `NEXT_PUBLIC_TERMS_URL` | `#terms-link-pending` | Terms page URL (MurageSite) |

## Control plane contract

- `POST /api/auth/email-otp/send-verification-otp`, `POST /api/auth/sign-in/email-otp` (token in `set-auth-token`)
- `GET /v1/account/2fa`, `POST /v1/account/2fa/{register,assert}[/options]` (new in this branch)
- `GET /v1/homes`
- `GET /v1/legal/disclosure?plan=` the clickwrap wording; `POST /v1/billing/checkout {plan, fp_tid?, consent}` returns `{url}` (must refuse a session that is not stepped up, or a missing box)
- `GET /v1/account/cloud`, `POST /v1/account/{cancel-plan,export-request,topup}`, `GET /v1/account/confirmation` (My Cloud)
- `POST /v1/billing/portal {}` returns `{url}` (lane 1)

## Checks

`npm install && npx tsc --noEmit && npx next build && npx playwright test` (run on the build host; see the browser journey in `e2e/`).
