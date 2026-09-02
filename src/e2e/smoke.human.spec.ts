// The rig's own test. It asserts nothing about product behaviour on purpose —
// its whole job is to prove that the four things every other human spec
// depends on are true: the harness booted against the scratch data dir, the
// fixtures were seeded into it, Vite is serving the app against that harness,
// and the sidebar is reachable at both viewports.
//
// If this fails, no other *.human.spec.ts result means anything.
import { FIXTURES } from "./rig";
import { expect, openSidebar, test } from "./fixtures";

/** The two viewports, asserted as capabilities rather than as numbers.
 *  Wave 1's M3 is about an affordance that only exists under a pointer, so a
 *  "mobile" project that still reports `hover: hover` would pass that work
 *  while proving nothing. Chromium derives these media features from touch
 *  emulation, so this is really an assertion about `hasTouch`. */
const SURFACES = {
  desktop: { width: 1440, height: 900, hover: true },
  mobile: { width: 390, height: 844, hover: false },
} as const;

test("the seeded workspace is on screen", async ({ app }, testInfo) => {
  const surface = SURFACES[testInfo.project.name as keyof typeof SURFACES];
  expect(app.viewportSize()).toEqual({ width: surface.width, height: surface.height });
  await expect
    .poll(() => app.evaluate(() => window.matchMedia("(hover: hover)").matches))
    .toBe(surface.hover);

  const sidebar = await openSidebar(app);

  for (const name of [FIXTURES.blank.name, FIXTURES.titledNoSkills.name, FIXTURES.smartTrader.name]) {
    await expect(sidebar.getByText(name, { exact: true })).toBeVisible();
  }

  // Exactly the seeded set: a stray bot here means the rig is talking to a
  // workspace it did not create.
  await expect(sidebar.getByText(/^E2E /)).toHaveCount(3);
});
