// Production build for cloud.murage.ai. Billing provider is Stripe only; the build refuses anything else.
const provider = process.env.NEXT_PUBLIC_BILLING_PROVIDER ?? "stripe";
if (provider !== "stripe") throw new Error(`NEXT_PUBLIC_BILLING_PROVIDER must be "stripe", got "${provider}"`);

const csp = [
  "default-src 'self'",
  "script-src 'self' 'unsafe-inline' https://cdn.firstpromoter.com",
  "connect-src 'self' https://*.firstpromoter.com https://firstpromoter.com",
  "img-src 'self' data: https:",
  "style-src 'self' 'unsafe-inline'",
  "frame-ancestors 'none'",
  "base-uri 'self'",
  "form-action 'self'",
].join("; ");

/** @type {import('next').NextConfig} */
export default {
  outputFileTracingRoot: import.meta.dirname,
  poweredByHeader: false,
  env: { NEXT_PUBLIC_BILLING_PROVIDER: provider },
  async headers() {
    return [{
      source: "/:path*",
      headers: [
        { key: "Content-Security-Policy", value: csp },
        { key: "X-Content-Type-Options", value: "nosniff" },
        { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
        { key: "Strict-Transport-Security", value: "max-age=31536000; includeSubDomains" },
        { key: "Permissions-Policy", value: "publickey-credentials-get=(self), publickey-credentials-create=(self)" },
      ],
    }];
  },
};
