import { expect, test, type BrowserContext, type Page } from "@playwright/test";

const BASE = "https://cloud.murage.test:3443";
const CP = "http://127.0.0.1:8788";
const REAL = process.env.JOURNEY_CP !== "fake";
const WHSEC = "whsec_e2efixturesecret0123456789";

/** The code the real Worker "emailed": captured from the EMAIL binding stub (the fake CP always used 12345678). */
const mailCount = async (email: string) => REAL
  ? ((await (await fetch(`${CP}/__e2e/outbox`)).json()) as { to: string }[]).filter((m) => m.to === email).length : 0;
async function otpFor(email: string, seen = 0): Promise<string> {
  if (!REAL) return "12345678";
  for (let i = 0; i < 40; i++) {
    const box = await (await fetch(`${CP}/__e2e/outbox`)).json() as { to: string; text: string }[];
    const mails = box.filter((m) => m.to === email);
    const mail = mails.length > seen ? mails.at(-1) : undefined;
    const code = mail?.text.match(/code is: (\d{8})/)?.[1];
    if (code) return code;
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error("no OTP mail captured");
}
async function stripeWebhook(type: string, object: Record<string, unknown>) {
  const raw = JSON.stringify({ id: `evt_e2e${Math.random().toString(36).slice(2, 10)}`, type, created: Math.floor(Date.now() / 1000), data: { object } });
  const t = Math.floor(Date.now() / 1000);
  const { createHmac } = await import("node:crypto");
  const sig = `t=${t},v1=${createHmac("sha256", WHSEC).update(`${t}.${raw}`).digest("hex")}`;
  const res = await fetch(`${CP}/v1/billing/webhook`, { method: "POST", headers: { "content-type": "application/json", "stripe-signature": sig }, body: raw });
  expect(res.status).toBe(200);
}

const consents = async () => ((await (await fetch(`${CP}/__e2e/consents`)).json()) as Record<string, unknown>[]);
const mailTo = async (email: string) => ((await (await fetch(`${CP}/__e2e/outbox`)).json()) as { to: string; subject: string; text: string }[]).filter((m) => m.to === email);
async function addSecondStep(context: BrowserContext, page: Page) {
  const cdp = await context.newCDPSession(page);
  await cdp.send("WebAuthn.enable");
  await cdp.send("WebAuthn.addVirtualAuthenticator", { options: {
    protocol: "ctap2", transport: "internal", hasResidentKey: true, hasUserVerification: true, isUserVerified: true, automaticPresenceSimulation: true,
  } });
}

async function signIn(page: Page, email: string, next = "/plans") {
  await page.goto(`/sign-in?next=${encodeURIComponent(next)}`);
  await page.getByLabel("Email").fill(email);
  const seen = await mailCount(email);
  await page.getByRole("button", { name: "Email me a code" }).click();
  await page.getByLabel("Code").fill(await otpFor(email, seen));
  await page.getByRole("button", { name: "Continue" }).click();
  await page.waitForURL(`**${next}`);
}
async function stubExternal(context: BrowserContext) {
  const fpr: string[] = [];
  await context.route("https://cdn.firstpromoter.com/**", (r) => { fpr.push(r.request().url()); return r.fulfill({ contentType: "text/javascript", body: "window.__fprLoaded=true;" }); });
  await context.route("https://checkout.stripe.test/**", (r) => r.fulfill({ contentType: "text/html", body: "<h1>Stub checkout</h1>" }));
  await context.route("https://billing.stripe.test/**", (r) => r.fulfill({ contentType: "text/html", body: "<h1>Stub billing portal</h1>" }));
  return fpr;
}

test("sign up, add 2FA, pick a plan, checkout, My Cloud", async ({ browser }) => {
  const context = await browser.newContext({ ignoreHTTPSErrors: true });
  const fprRequests = await stubExternal(context);
  await context.addCookies([{ name: "_fprom_tid", value: "fp-tid-journey", url: BASE }]);
  const page = await context.newPage();
  const cdp = await context.newCDPSession(page);
  await cdp.send("WebAuthn.enable");
  await cdp.send("WebAuthn.addVirtualAuthenticator", { options: {
    protocol: "ctap2", transport: "internal", hasResidentKey: true, hasUserVerification: true, isUserVerified: true, automaticPresenceSimulation: true,
  } });

  // Plans: three plans with specs and Flux credits. Public page, no sign-in needed.
  await page.goto("/plans");
  await expect(page.locator("[data-plan]")).toHaveCount(3);
  await expect(page.locator('[data-plan="starter"]')).toContainText("$49");
  await expect(page.locator('[data-plan="pro"]')).toContainText("$20 of Flux credits");
  await expect(page.locator('[data-plan="max"]')).toContainText("Priority support");
  await expect(page.getByText("Customers in the EU get 14 days").first()).toBeVisible();
  // FirstPromoter: a plain visit loads no tracker (the fp_tid cookie was pre-set above, so use a clean context for that: see the
  // "no FirstPromoter without a partner link" test). With the cookie present the tracker loads.
  await expect(page.locator('script[src="https://cdn.firstpromoter.com/fpr.js"]')).toHaveCount(1);
  await expect.poll(() => fprRequests.length).toBeGreaterThan(0);
  expect(await page.evaluate(() => typeof (window as any).fpr)).toBe("function");

  // Signed out: checkout sends the person to sign in. Signing up and signing in are the same step.
  await page.locator('[data-plan="pro"]').getByRole("button").click();
  await page.waitForURL("**/sign-in?next=%2Fplans");
  await page.getByLabel("Email").fill("buyer@example.com");
  await page.getByRole("button", { name: "Email me a code" }).click();
  await page.getByLabel("Code").fill(await otpFor("buyer@example.com"));
  await page.getByRole("button", { name: "Continue" }).click();
  await page.waitForURL("**/plans");

  // No second step yet: checkout is refused and the person is sent to add one.
  await page.locator('[data-plan="pro"]').getByRole("button", { name: "Check out Pro" }).click();
  await page.waitForURL("**/security?next=%2Fplans");
  await expect(page.getByTestId("2fa-status")).toHaveText("No second step yet.");
  const add = page.getByRole("button", { name: "Add a second step" });
  await expect(add).toBeEnabled();
  await add.click();
  await page.waitForURL("**/plans");

  // Clickwrap (CHECKOUT.md): the renewal statement first, before any billing field; two required boxes, unticked; pay stays disabled until both are ticked.
  await page.locator('[data-plan="pro"]').getByRole("button", { name: "Check out Pro" }).click();
  await page.waitForURL("**/checkout?plan=pro");
  const top = page.getByTestId("renewal-top");
  await expect(top).toContainText("Pro renews monthly at US$99 plus applicable tax, charged on the same day each month until you cancel.");
  await expect(top).toContainText("Cancel any time from your account page, with one click and no call or email. Your server runs to the end of the month you paid for.");
  await expect(top).toContainText("Ask within 7 days of your first payment and we refund your first month.");
  await expect(top).toContainText("Your service starts today");
  const boxes = {
    country: await page.getByLabel("Billing country").boundingBox(), top: await top.boundingBox(), again: await page.getByTestId("renewal-box").boundingBox(),
    terms: await page.getByRole("checkbox", { name: /I have read and agree to the Murage Cloud terms/ }).boundingBox(),
    auth: await page.getByRole("checkbox", { name: /I authorize Ferrox Labs, LLC to charge my payment method/ }).boundingBox(),
    topup: await page.getByRole("checkbox", { name: /Top up my Flux credits automatically/ }).boundingBox(), pay: await page.getByTestId("pay").boundingBox(),
  };
  expect(boxes.top!.y).toBeLessThan(boxes.country!.y);          // renewal block before the billing fields
  expect(boxes.country!.y).toBeLessThan(boxes.again!.y);        // and again beside the boxes
  expect(boxes.again!.y).toBeLessThan(boxes.terms!.y);
  expect(boxes.terms!.y).toBeLessThan(boxes.auth!.y);
  expect(boxes.auth!.y).toBeLessThan(boxes.topup!.y);
  expect(boxes.topup!.y).toBeLessThan(boxes.pay!.y);
  // The total including tax is priced by Stripe Tax for this address (country plus postal code) and shown next to the boxes, BEFORE any
  // box is ticked; "due today" is kept apart from the monthly total.
  await page.getByLabel("Postal code").fill("94105");
  await expect(page.getByTestId("tax-line")).toHaveText("Pro: $99.00 plus $8.17 tax = $107.17 a month. Due today: $107.17.");
  await expect(page.getByTestId("renewal-box")).toContainText("Today's total is $107.17 in USD.");
  await expect(page.getByTestId("renewal-top")).toContainText("Total including tax: $107.17 a month");
  // Stripe Tax down (postal code 00000 in the fixtures): no quote, no checkout. The message is exact and pay stays disabled, even with both boxes ticked.
  await page.getByLabel("Postal code").fill("00000");
  await expect(page.getByTestId("tax-line")).toHaveText("We couldn't calculate tax just now. Please try again in a moment.");
  await page.getByRole("checkbox", { name: /I have read and agree to the Murage Cloud terms/ }).check();
  await page.getByRole("checkbox", { name: /I authorize Ferrox Labs, LLC to charge my payment method/ }).check();
  await expect(page.getByTestId("pay")).toBeDisabled();
  await page.getByRole("checkbox", { name: /I have read and agree to the Murage Cloud terms/ }).uncheck();
  await page.getByRole("checkbox", { name: /I authorize Ferrox Labs, LLC to charge my payment method/ }).uncheck();
  await page.getByLabel("Postal code").fill("94105");
  await expect(page.getByTestId("tax-line")).toHaveText("Pro: $99.00 plus $8.17 tax = $107.17 a month. Due today: $107.17.");
  const terms = page.getByRole("checkbox", { name: /I have read and agree to the Murage Cloud terms, the Terms of Service and the Privacy Policy/ });
  const authorize = page.getByRole("checkbox", { name: "I authorize Ferrox Labs, LLC to charge my payment method for this monthly subscription until I cancel." });
  const topup = page.getByRole("checkbox", { name: /Top up my Flux credits automatically: add \$20 whenever my balance falls below \$5, up to a monthly cap of \$\d+\./ });
  await expect(terms).not.toBeChecked(); await expect(authorize).not.toBeChecked(); await expect(topup).not.toBeChecked();
  await expect(page.getByTestId("arbitration")).toHaveText("Disputes go to individual arbitration, not class actions, unless you are a consumer in the EU, EEA, UK or Switzerland. You can opt out within 30 days of ticking this box: email privacy@murage.ai.");
  const pay = page.getByTestId("pay");
  await expect(pay).toBeDisabled();
  await terms.check(); await expect(pay).toBeDisabled();
  await authorize.check(); await expect(pay).toBeEnabled();
  // EU/EEA/UK: the start-now box appears, unticked, with the delayed start date; ticking it starts today. Elsewhere it is not shown.
  await expect(page.getByTestId("eu-block")).toHaveCount(0);
  await page.getByLabel("Billing country").selectOption("DE");
  await expect(page.getByTestId("eu-block")).toBeVisible();
  const early = page.getByRole("checkbox", { name: /Start my service before the 14-day withdrawal period ends/ });
  await expect(early).not.toBeChecked();
  await expect(page.getByTestId("eu-block")).toContainText("If you buy as a consumer in the EU, EEA or UK and want your server right away, tick the start-now box.");
  await expect(page.getByTestId("renewal-box")).toContainText("You are not charged until then");
  await expect(page.getByTestId("renewal-box")).toContainText("Your first charge of $117.81 is on");
  await early.check();
  await expect(page.getByTestId("renewal-box")).toContainText("Your service starts today");
  await page.getByLabel("Billing country").selectOption("US");
  await expect(page.getByTestId("eu-block")).toHaveCount(0);
  // Auto top-up: unticked, pre-filled and editable; the wording follows the numbers; it is not required.
  await expect(page.getByLabel("Top-up amount (USD)")).toHaveValue("20");
  await expect(page.getByLabel("When balance falls below (USD)")).toHaveValue("5");
  await expect(page.getByLabel("Monthly cap (USD)")).toHaveValue("100");
  await page.getByLabel("Monthly cap (USD)").fill("120");
  await expect(page.getByTestId("topup-text")).toContainText("up to a monthly cap of $120");
  await topup.check();
  await expect(page.getByTestId("topup-charge")).toContainText("charge my payment method $21.65 including tax for $20 of Flux credits");
  await expect(page.getByTestId("topup-charge")).toContainText("up to $120 per calendar month. The cap resets at 00:00 UTC on the first day of each month. It covers automatic top-up charges only, not my plan or manual purchases.");

  // Pay: control plane gets the plan, the consent and the FirstPromoter tracking id.
  await pay.click();
  await page.waitForURL("https://checkout.stripe.test/**");
  await expect(page.getByRole("heading", { name: "Stub checkout" })).toBeVisible();
  let homeId = "";
  if (REAL) {
    // The real Worker called (fixture) Stripe: Pro's price, the home as client reference, and the FirstPromoter id in metadata.
    const calls = await (await fetch(`${CP}/__e2e/stripe-calls`)).json() as { path: string; form: Record<string, string> }[];
    const session = calls.filter((c) => c.path === "/v1/checkout/sessions").at(-1)!;
    expect(Object.values(session.form)).toEqual(expect.arrayContaining(["price_pro00000001", "fp-tid-journey"]));
    // US buyer: no trial, so the service and the first charge start now; the renewal statement sits beside Stripe's pay button.
    expect(session.form["subscription_data[trial_end]"]).toBeUndefined();
    expect(session.form["custom_text[submit][message]"]).toContain("Pro renews monthly at US$99 plus applicable tax");
    const consentId = session.form["metadata[consent_id]"];
    expect(consentId).toMatch(/^consent-/);
    // One consent record, written by the control plane before Stripe was called: versions, boxes, wording, top-up numbers, IP and user agent.
    const log = (await consents()).find((c) => c.id === consentId)!;
    expect(log).toMatchObject({ plan: "pro", billing_country: "US", terms_accepted: 1, recurring_authorized: 1, early_start: 0, eu_region: 0, delayed_start: 0,
      topup_enabled: 1, topup_amount_cents: 2000, topup_threshold_cents: 500, topup_cap_cents: 12000, price_cents: 9900 });
    expect(String(log.cloud_terms_version)).toMatch(/^cloud-terms-[0-9a-f]{12}$/);
    expect(String(log.tos_version)).toMatch(/^terms-of-service-[0-9a-f]{12}$/);
    expect(String(log.renewal_text)).toContain("Pro renews monthly at US$99 plus applicable tax");
    expect(String(log.user_agent)).toContain("Chrome");
    expect(String(log.ip)).not.toBe("");
    // The server-priced disclosure the boxes were ticked beside, and both the claimed and the observed request metadata.
    expect(log).toMatchObject({ postal_code: "94105", tax_source: "stripe_tax", quoted_tax_cents: 817, quoted_total_cents: 10717, quoted_topup_total_cents: 2165 });
    expect(String(log.quote_id)).toMatch(/^quote-/);
    expect(JSON.parse(String(log.client_meta))).toMatchObject({ claimed: { userAgent: expect.stringContaining("Chrome") }, observed: { ip: expect.any(String) } });
    // The home came from the real user-scoped reserve route (no test-only stand-in): the portal reserved it when Pro was picked.
    homeId = Object.values(session.form).find((v) => /^home-[0-9a-f]{24}$/.test(v)) ?? "";
    expect(homeId).not.toBe("");
    // Stripe's events arrive (signed with the webhook secret), the lifecycle runs, and the home is owned by this account.
    await stripeWebhook("checkout.session.completed", { object: "checkout.session", id: "cs_test_e2e0001", mode: "subscription", payment_status: "paid",
      customer: "cus_e2e0001", subscription: "sub_e2e0001", invoice: "in_e2e0001", client_reference_id: homeId, amount_total: 10717, total_details: { amount_tax: 817 },
      customer_details: { address: { country: "US" } }, metadata: { home_id: homeId, plan: "pro", consent_id: consentId } });
    const now = Math.floor(Date.now() / 1000);
    await stripeWebhook("invoice.paid", { object: "invoice", id: "in_e2e0001", customer: "cus_e2e0001", subscription: "sub_e2e0001",
      billing_reason: "subscription_create", amount_paid: 10717,
      lines: { data: [{ price: { id: "price_pro00000001" }, period: { start: now, end: now + 30 * 86400 } }] } });
    expect((await (await fetch(`${CP}/__e2e/reconcile`)).json() as { status: number }).status).toBe(200);
  } else {
    const calls = await (await fetch(`${CP}/__calls`)).json() as { body: { plan: string; fp_tid?: string; consent: Record<string, unknown> } }[];
    expect(calls.at(-1)?.body).toMatchObject({ plan: "pro", fp_tid: "fp-tid-journey", consent: { termsAccepted: true, recurringAuthorized: true, earlyStart: false,
      billingCountry: "US", postalCode: "94105", quoteId: expect.stringMatching(/^quote-/), documentVersions: { cloudTerms: expect.stringMatching(/^cloud-terms-/) },
      topup: { enabled: true, amountUsd: 20, thresholdUsd: 5, capUsd: 120 } } });
  }

  // My Cloud.
  await page.goto("/cloud");
  if (REAL) {
    await expect(page.getByTestId("home")).toHaveCount(1);
    await expect(page.getByTestId("home-status")).not.toHaveText("");
  } else {
    await expect(page.getByTestId("home-status")).toHaveText("Running");
    await expect(page.getByRole("link", { name: "Open your home" })).toHaveAttribute("href", "https://home-test.murage.test");
  }
  // Plan card, with the online Cancel plan button (no contact step) and the saved top-up authorization.
  await expect(page.getByTestId("plan-name")).toHaveText("Pro");
  await expect(page.getByTestId("cancel-plan")).toBeVisible();
  await expect(page.getByLabel("Monthly cap (USD)")).toHaveValue("120");
  if (REAL) {
    // The durable confirmation was emailed before service started, with full copies (not links) of the documents.
    const confirmation = (await mailTo("buyer@example.com")).find((m) => m.subject.includes("order confirmation"))!;
    expect(confirmation).toBeTruthy();
    expect(confirmation.text).toContain("COPY OF THE MURAGE CLOUD TERMS");
    expect(confirmation.text).toContain("COPY OF THE TERMS OF SERVICE");
    expect(confirmation.text).toContain("Pro renews monthly at US$99 plus applicable tax");
    expect(confirmation.text).toContain("COPY OF YOUR AUTOMATIC TOP-UP AUTHORIZATION");
    expect(confirmation.text).toContain("Monthly cap: $120.00");
    expect(confirmation.text).toContain("Total including tax: $107.17 a month ($99.00 plus $8.17 tax), as shown before you agreed.");
    expect(confirmation.text).toContain("Level | What it means"); // complete copies: the permissions table is in the Terms of Service copy
    expect(confirmation.text).not.toContain("MODEL WITHDRAWAL FORM"); // US buyer
    expect(((await (await fetch(`${CP}/__e2e/topups`)).json()) as { enabled: number; cap_cents: number }[])[0]).toMatchObject({ enabled: 1, cap_cents: 12000 });
  }
  // The confirmation is kept on the account page too: a copy, not a link to the site.
  await page.getByTestId("confirmation-link").click();
  await page.waitForURL("**/cloud/confirmation");
  await expect(page.getByTestId("confirmation-text")).toContainText("COPY OF THE MURAGE CLOUD TERMS");
  await page.goto("/cloud");
  // Turn the auto top-up off and change the cap from My Cloud.
  await page.getByLabel("Top up my Flux credits automatically").uncheck();
  await page.getByLabel("Monthly cap (USD)").fill("80");
  await page.getByRole("button", { name: "Save top-up settings" }).click();
  await expect(page.getByTestId("notice")).toHaveText("Your top-up settings are saved.");
  await expect(page.getByLabel("Monthly cap (USD)")).toHaveValue("80");
  await expect(page.getByLabel("Top up my Flux credits automatically")).not.toBeChecked();
  // Before B4 is merged the Flux side is the stub: the page says plainly that automatic top-up is not active.
  if (REAL) await expect(page.getByTestId("topup-pending")).toBeVisible();
  // Changed terms: at the next visit the customer is asked to accept them again, and the acceptance is logged.
  if (REAL) {
    expect((await (await fetch(`${CP}/__e2e/age-terms?email=buyer@example.com`)).json() as { changed: number }).changed).toBeGreaterThan(0);
    await page.goto("/cloud");
    await expect(page.getByTestId("reaccept")).toContainText("Our terms have changed");
    await expect(page.getByTestId("reaccept-consequence")).toContainText("If you never accept them, your current terms keep running to the end of the period you have paid for, and then your plan does not renew.");
    await page.getByTestId("reaccept-submit").click();
    await expect(page.locator("p.error[role=alert]")).toContainText("Tick the box to accept the updated terms");
    await page.getByTestId("reaccept").getByRole("checkbox").check();
    await page.getByTestId("reaccept-submit").click();
    await expect(page.getByTestId("notice")).toHaveText("Thank you. You accepted the updated terms.");
    await expect(page.getByTestId("reaccept")).toHaveCount(0);
    expect(((await (await fetch(`${CP}/__e2e/acceptances`)).json()) as { source: string }[]).some((a) => a.source === "reaccept")).toBe(true);
  }
  // "Request my data": recorded; while it is open the page says deletion waits.
  await page.getByTestId("request-export").click();
  await expect(page.getByTestId("notice")).toContainText("We recorded your data request");
  await expect(page.getByTestId("export-open")).toContainText("We do not delete your data while it is open");
  if (REAL) expect((await (await fetch(`${CP}/__e2e/exports`)).json() as { status: string }[])[0].status).toBe("open");
  // Cancel plan: one click, confirmed on the page and by email.
  await page.getByTestId("cancel-plan").click();
  await expect(page.getByTestId("notice")).toContainText("Your plan is cancelled");
  await expect(page.getByTestId("cancel-state")).toContainText("Your plan ends on");
  await expect(page.getByTestId("cancel-plan")).toHaveCount(0);
  if (REAL) {
    const calls = await (await fetch(`${CP}/__e2e/stripe-calls`)).json() as { method: string; path: string; form: Record<string, string> }[];
    expect(calls.filter((c) => c.method === "POST" && c.path === "/v1/subscriptions/sub_e2e0001").at(-1)!.form.cancel_at_period_end).toBe("true");
    expect((await mailTo("buyer@example.com")).some((m) => m.subject.includes("your plan is cancelled"))).toBe(true);
  }
  await page.getByRole("button", { name: "Manage billing" }).click();
  await page.waitForURL("https://billing.stripe.test/**");
  await expect(page.getByRole("heading", { name: "Stub billing portal" })).toBeVisible();

  // FirstPromoter loads on every page.
  for (const path of ["/cloud", "/security", "/sign-in"]) {
    await page.goto(path);
    await expect(page.locator("script#fpr-js, script[src*='firstpromoter']").first()).toBeAttached();
  }
  await context.close();
});

test("EU buyer without the start-now box: delayed start shown, billed from day 15, withdrawal form in the confirmation", async ({ browser }) => {
  test.skip(!REAL, "needs the real control plane");
  const context = await browser.newContext({ ignoreHTTPSErrors: true });
  await stubExternal(context);
  const page = await context.newPage();
  await addSecondStep(context, page);
  await signIn(page, "eu-buyer@example.com", "/plans");
  await page.locator('[data-plan="starter"]').getByRole("button", { name: "Check out Starter" }).click();
  await page.waitForURL("**/security?next=%2Fplans");
  await page.getByRole("button", { name: "Add a second step" }).click();
  await page.waitForURL("**/plans");
  await page.locator('[data-plan="starter"]').getByRole("button", { name: "Check out Starter" }).click();
  await page.waitForURL("**/checkout?plan=starter");
  await page.getByLabel("Billing country").selectOption("FR");
  await expect(page.getByTestId("renewal-box")).toContainText("You are not charged until then");
  await expect(page.getByTestId("tax-line")).toHaveText("Starter: $49.00 plus $9.80 tax = $58.80 a month. Due today: $0.00.");
  await expect(page.getByRole("checkbox", { name: /Start my service before the 14-day withdrawal period ends/ })).not.toBeChecked();
  await page.getByRole("checkbox", { name: /I have read and agree to the Murage Cloud terms/ }).check();
  await page.getByRole("checkbox", { name: /I authorize Ferrox Labs, LLC/ }).check();
  await page.getByTestId("pay").click();
  await page.waitForURL("https://checkout.stripe.test/**");
  const calls = await (await fetch(`${CP}/__e2e/stripe-calls`)).json() as { path: string; form: Record<string, string> }[];
  const session = calls.filter((c) => c.path === "/v1/checkout/sessions").at(-1)!;
  // Billing starts on the service start date, not the checkout date: a trial ends on day 15.
  const trialEnd = Number(session.form["subscription_data[trial_end]"]);
  expect(trialEnd * 1000 - Date.now()).toBeGreaterThan(14.9 * 86_400_000);
  expect(trialEnd * 1000 - Date.now()).toBeLessThan(15.1 * 86_400_000);
  const log = (await consents()).find((c) => c.id === session.form["metadata[consent_id]"])!;
  expect(log).toMatchObject({ billing_country: "FR", eu_region: 1, early_start: 0, delayed_start: 1, terms_accepted: 1, recurring_authorized: 1 });
  const homeId = Object.values(session.form).find((v) => /^home-[0-9a-f]{24}$/.test(v))!;
  await stripeWebhook("checkout.session.completed", { object: "checkout.session", id: "cs_test_e2eeu01", mode: "subscription", payment_status: "no_payment_required",
    customer: "cus_e2eeu01", subscription: "sub_e2eeu01", client_reference_id: homeId, amount_total: 0, total_details: { amount_tax: 0 },
    customer_details: { address: { country: "FR" } }, metadata: { home_id: homeId, plan: "starter", consent_id: session.form["metadata[consent_id]"] } });
  const mail = (await mailTo("eu-buyer@example.com")).find((m) => m.subject.includes("order confirmation"))!;
  expect(mail.text).toContain("MODEL WITHDRAWAL FORM");
  expect(mail.text).toContain("You pay nothing until then");
  await page.goto("/cloud");
  await expect(page.getByTestId("start-date")).toContainText("Your service starts on");
  await expect(page.getByTestId("start-date")).toContainText("You are not charged until then");
  // Online withdrawal (Directive 2023/2673): a labelled button inside the 14 days, one confirm step, an immediate acknowledgement with date and time.
  await expect(page.getByTestId("withdraw-link")).toHaveText("Withdraw from contract here");
  await page.getByTestId("withdraw-link").click();
  await page.waitForURL("**/cloud/withdraw");
  await page.getByLabel("Your name (optional)").fill("Eve Buyer");
  await page.getByRole("button", { name: "Confirm withdrawal here" }).click();
  await expect(page.getByTestId("notice")).toContainText("We received your withdrawal");
  await expect(page.getByTestId("withdraw-card")).toHaveCount(0);
  const ack = (await mailTo("eu-buyer@example.com")).find((m) => m.subject.includes("received your withdrawal"))!;
  expect(ack.text).toMatch(/Received: \d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2} UTC/);
  expect(ack.text).toContain("Name given: Eve Buyer");
  const rows = await (await fetch(`${CP}/__e2e/withdrawals`)).json() as { status: string; name: string }[];
  expect(rows).toHaveLength(1); expect(rows[0]).toMatchObject({ name: "Eve Buyer", status: "completed" });
  await context.close();
});

test("a fresh email sign-in cannot buy or add a device without the second step", async ({ browser }) => {
  const context = await browser.newContext({ ignoreHTTPSErrors: true });
  await stubExternal(context);
  const page = await context.newPage();
  const cdp = await context.newCDPSession(page);
  await cdp.send("WebAuthn.enable");
  await cdp.send("WebAuthn.addVirtualAuthenticator", { options: {
    protocol: "ctap2", transport: "internal", hasResidentKey: true, hasUserVerification: true, isUserVerified: true, automaticPresenceSimulation: true,
  } });
  await signIn(page, "owner@example.com", "/security");
  await page.getByRole("button", { name: "Add a second step" }).click();
  await page.waitForURL("**/security");

  // Same account, new session (email only): enrolled, not confirmed.
  const other = await (await browser.newContext({ ignoreHTTPSErrors: true })).newPage();
  await signIn(other, "owner@example.com", "/plans");
  await other.locator('[data-plan="pro"]').getByRole("button", { name: "Check out Pro" }).click();
  await other.waitForURL("**/security?next=%2Fplans");
  await expect(other.getByTestId("2fa-status")).toHaveText("You have a second step set up. Confirm it now.");
  await expect(other.getByRole("button", { name: "Add another device" })).toHaveCount(0);

  // The control plane refuses a registration from the unconfirmed session even if the page is bypassed.
  const refused = await other.evaluate(async () => (await fetch("/api/2fa/register/options", {
    method: "POST", headers: { "content-type": "application/json" }, body: "{}" })).status);
  expect(refused).toBe(403);
  await context.close();
  await other.context().close();
});

test("the control plane itself refuses checkout without a confirmed second step", async () => {
  test.skip(!REAL, "needs the real control plane");
  const email = "api-only@example.com";
  const call = async (path: string, body?: unknown, token?: string) => fetch(`${CP}${path}`, {
    method: body === undefined ? "GET" : "POST", headers: { "content-type": "application/json", origin: "https://cloud.murage.test:3443", ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body) });
  expect((await call("/api/auth/email-otp/send-verification-otp", { email, type: "sign-in" })).status).toBe(200);
  const signedIn = await call("/api/auth/sign-in/email-otp", { email, otp: await otpFor(email, 0) });
  expect(signedIn.status).toBe(200);
  const token = signedIn.headers.get("set-auth-token")!;
  expect(token).toBeTruthy();
  // The user-scoped reserve route refuses a session without a confirmed second step, and an anonymous caller.
  const refused = await call("/v1/billing/reserve", {}, token);
  expect(refused.status).toBe(403);
  expect(await refused.json()).toEqual({ error: "step_up_required" });
  expect((await call("/v1/billing/reserve", {})).status).toBe(401);
  // Nothing was reserved, so there is nothing payable to check out.
  const disclosure = await (await call("/v1/legal/disclosure?plan=pro")).json() as { versions: Record<string, string> };
  const consent = { termsAccepted: true, recurringAuthorized: true, billingCountry: "US", renewalText: "x", screenVersion: "x", documentVersions: disclosure.versions };
  expect((await call("/v1/billing/checkout", { plan: "pro", consent }, token)).status).toBe(404);
  expect((await call("/v1/billing/checkout", { plan: "pro", consent })).status).toBe(401);
  // And the pay step itself refuses to go on without both boxes on record.
  expect((await call("/v1/billing/checkout", { plan: "pro" }, token)).status).toBe(400);
});

test("no FirstPromoter script or cookie on a plain visit; a partner link (?fpr=) loads it", async ({ browser }) => {
  const context = await browser.newContext({ ignoreHTTPSErrors: true });
  const fpr = await stubExternal(context);
  const page = await context.newPage();
  await page.goto("/plans");
  await page.waitForLoadState("networkidle");
  await expect(page.locator("script#fpr-js, script[src*='firstpromoter']")).toHaveCount(0);
  expect(fpr).toHaveLength(0);
  expect((await context.cookies()).filter((c) => c.name.startsWith("_fprom"))).toHaveLength(0);
  await page.goto("/plans?fpr=partner1");
  await expect(page.locator("script#fpr-js")).toHaveCount(1);
  await expect.poll(() => fpr.length).toBeGreaterThan(0);
  await context.close();
});
