import { expect, test, type Page } from "@playwright/test";
import { writeFileSync } from "node:fs";

// Needs: STAGING_CP_URL, STAGING_EMAIL, STAGING_OTP (seeded in staging D1 by the operator), STAGING_PLAN (starter|pro).
const CP = process.env.STAGING_CP_URL!;
const EMAIL = process.env.STAGING_EMAIL!;
const OTP = process.env.STAGING_OTP!;
const PLAN = process.env.STAGING_PLAN ?? "starter";
const OUT = process.env.STAGING_EVIDENCE_DIR ?? "test-results-staging";
const BASE = "https://cloud.murage.test:3443";

async function fillStripe(page: Page) {
  await page.waitForLoadState("domcontentloaded");
  await page.waitForSelector("#cardNumber, [name=cardNumber]", { timeout: 60_000 });
  await page.screenshot({ path: `${OUT}/stripe-1-loaded.png`, fullPage: true });
  const email = page.locator("#email");
  if (await email.count() && !(await email.inputValue())) await email.fill(EMAIL);
  await page.locator("#cardNumber").fill("4242424242424242");
  await page.locator("#cardExpiry").fill("12 / 34");
  await page.locator("#cardCvc").fill("123");
  await page.locator("#billingName").fill("Launch Rehearsal");
  const country = page.locator("#billingCountry");
  if (await country.count()) await country.selectOption("US");
  const line1 = page.locator("#billingAddressLine1");
  if (await line1.count()) await line1.fill("354 Oyster Point Blvd");
  const city = page.locator("#billingLocality");
  if (await city.count()) await city.fill("South San Francisco");
  const state = page.locator("#billingAdministrativeArea");
  if (await state.count()) await state.selectOption("CA");
  const zip = page.locator("#billingPostalCode");
  if (await zip.count()) await zip.fill("94080");
  await page.screenshot({ path: `${OUT}/stripe-2-filled.png`, fullPage: true });
  await page.locator("button[type=submit]").click();
}

test("sign up, passkey, pay with a Stripe test card, a home is created", async ({ browser }) => {
  const context = await browser.newContext({ ignoreHTTPSErrors: true });
  const page = await context.newPage();
  const net: string[] = [];
  page.on("console", (m) => { if (m.type() === "error" || m.type() === "warning") net.push(`console ${m.type()}: ${m.text().slice(0, 300)}`); });
  page.on("requestfailed", (r) => net.push(`FAILED ${r.method()} ${r.url().slice(0, 160)} ${r.failure()?.errorText}`));
  page.on("response", (r) => { if (r.status() >= 400 && /stripe/.test(r.url())) net.push(`HTTP ${r.status()} ${r.url().slice(0, 160)}`); });
  const cdp = await context.newCDPSession(page);
  await cdp.send("WebAuthn.enable");
  await cdp.send("WebAuthn.addVirtualAuthenticator", { options: {
    protocol: "ctap2", transport: "internal", hasResidentKey: true, hasUserVerification: true, isUserVerified: true, automaticPresenceSimulation: true } });

  // Sign up / sign in (the operator seeded the one-time code, so no mailbox is needed); the portal keeps the bearer in this cookie.
  const signed = await fetch(`${CP}/api/auth/sign-in/email-otp`, { method: "POST",
    headers: { "content-type": "application/json", origin: BASE }, body: JSON.stringify({ email: EMAIL, otp: OTP }) });
  expect(signed.status).toBe(200);
  const token = signed.headers.get("set-auth-token")!;
  expect(token).toBeTruthy();
  await context.addCookies([{ name: "__Host-murage_cloud", value: token, url: BASE, httpOnly: true, secure: true, sameSite: "Lax" }]);

  // Passkey (virtual authenticator).
  await page.goto("/security");
  await expect(page.getByTestId("2fa-status")).toHaveText("No second step yet.");
  await page.getByRole("button", { name: "Add a second step" }).click();
  await expect(page.getByTestId("2fa-status")).toHaveText(/Confirmed/, { timeout: 30_000 });
  await page.screenshot({ path: `${OUT}/security-after-passkey.png` });

  // Pick the plan: the portal reserves a home (real route), then Stripe Checkout (hosted, test mode).
  await page.goto("/plans");
  const cap = PLAN[0].toUpperCase() + PLAN.slice(1);
  await page.locator(`[data-plan="${PLAN}"]`).getByRole("button", { name: `Check out ${cap}` }).click();
  await page.waitForURL(/checkout\.stripe\.com/, { timeout: 60_000 });
  writeFileSync(`${OUT}/checkout-url.txt`, page.url().split("#")[0]);
  await page.screenshot({ path: `${OUT}/stripe-0-checkout.png`, fullPage: true });
  if (process.env.STAGING_SKIP_STRIPE_UI === "1") { writeFileSync(`${OUT}/net.log`, net.join("\n")); await context.close(); return; }
  await fillStripe(page);
  try {
    await page.waitForURL(/cloud\.murage\.test:3443\/billing\/success/, { timeout: 90_000 });
  } finally { writeFileSync(`${OUT}/stripe-net.log`, net.join("\n")); await page.screenshot({ path: `${OUT}/stripe-3-after.png`, fullPage: true }).catch(() => {}); }
  await page.screenshot({ path: `${OUT}/paid-return.png` });
  writeFileSync(`${OUT}/return-url.txt`, page.url());
  await context.close();
});
