import {it,expect} from "vitest";
import {execFileSync} from "node:child_process";
it("Mac update guard and startup gate node regressions",()=>{
  const output=execFileSync(process.execPath,["--test","electron/mac-install-guard.node-test.mjs","electron/update-start-gate.node-test.mjs"],{encoding:"utf8",timeout:30000});
  expect(output).toMatch(/(?:fail 0|# fail 0)/);
});
