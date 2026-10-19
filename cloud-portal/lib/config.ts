import "server-only";

/** Server-side settings. Nothing here is a secret; the portal holds no keys of its own. */
export const config = {
  /** The control plane that owns accounts, 2FA, homes and billing. */
  cpUrl: (process.env.CP_URL ?? "https://accounts.murage.ai").replace(/\/+$/, ""),
  /** This site's exact origin. WebAuthn is bound to it; the control plane checks it too. */
  portalOrigin: process.env.PORTAL_ORIGIN ?? "https://cloud.murage.ai",
  /** Only these hosts may be followed after checkout or billing calls. */
  redirectHosts: (process.env.CHECKOUT_REDIRECT_HOSTS ?? "checkout.stripe.com,billing.stripe.com")
    .split(",").map((h) => h.trim().toLowerCase()).filter(Boolean),
  /** Placeholder until MurageSite publishes the terms page. */
  termsUrl: process.env.NEXT_PUBLIC_TERMS_URL ?? "#terms-link-pending",
  /** The public site that holds the legal pages the checkout boxes link to. */
  siteUrl: (process.env.NEXT_PUBLIC_SITE_URL ?? "https://murage.ai").replace(/\/+$/, ""),
  cookieName: process.env.PORTAL_COOKIE_NAME ?? "__Host-murage_cloud",
};
