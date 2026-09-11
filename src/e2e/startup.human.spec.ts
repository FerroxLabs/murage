import { test,expect } from "@playwright/test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
// @ts-expect-error Test-only Vite launcher is a native ESM helper.
import { startStartupUiFixture } from "../../scripts/testing/startup-ui-fixture.mjs";
import { safeWipeSync } from "../../server/testing/safe-wipe.mjs";
let fixture:{url:string;close:()=>Promise<void>},cache:string;
test.beforeAll(async()=>{cache=mkdtempSync(join(tmpdir(),"murage-startup-ui-"));fixture=await startStartupUiFixture(cache);});
test.afterAll(async()=>{await fixture?.close();if(cache)safeWipeSync(cache);});
test("startup controls report confirmed state and keep missing-tray launches visible",async({page},info)=>{
  for(const skin of ["light","dark"]){
    await page.goto(`${fixture.url}?skin=${skin}`);
    const background=page.getByRole("switch",{name:"Keep running when the window closes"}),login=page.getByRole("switch",{name:"Start when I sign in"});
    await expect(background).toHaveAttribute("aria-checked","false");await expect(login).toHaveAttribute("aria-checked","false");
    await background.click();await login.click();await expect(background).toHaveAttribute("aria-checked","true");await expect(login).toHaveAttribute("aria-checked","true");
    await expect(page.getByText("Sign-in startup opens quietly in the menu bar or tray.",{exact:true})).toBeVisible();
    expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1)).toBe(true);
    expect(await page.evaluate(()=>(window as any).fixtureWrites)).toEqual([{keepRunning:true},{startAtLogin:true}]);
    await page.screenshot({path:info.outputPath(`startup-${skin}.png`)});
  }
  await page.goto(`${fixture.url}?tray=missing`);
  await expect(page.getByRole("switch",{name:"Keep running when the window closes"})).toBeDisabled();
  await page.getByRole("switch",{name:"Start when I sign in"}).click();
  await expect(page.getByText(/Sign-in startup opens the window/)).toBeVisible();
});
