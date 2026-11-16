// Owners: release runner retains evidence; MAIN owns release decisions.
import { appendFileSync } from 'node:fs';
const fullName = test => {
  const names = [test.name];
  for (let parent = test.parent; parent && parent.type !== 'module'; parent = parent.parent) names.unshift(parent.name);
  return names.join(' ');
};
export default class Reporter {
  onTestModuleQueued(module) { this.event(module.moduleId, '<MODULE>', 'collecting'); }
  onTestModuleStart(module) { this.event(module.moduleId, '<MODULE>', 'module-running'); }
  onTestCaseReady(test) { this.event(test.module.moduleId, fullName(test), 'running'); }
  onTestCaseResult(test) { const result=test.result(); this.event(test.module.moduleId, fullName(test), result.state, result.errors?.map(error=>({message:error.message,stack:error.stack}))); }
  event(file, id, status, errors) {
    appendFileSync(process.env.GATE_IDS, JSON.stringify({at:Date.now(),file:file.replace(/^\/work\//,''),id,status,errors})+'\n');
  }
  onTestModuleEnd(module) {
    const tests = [...module.children.allTests()].map(test => ({id:fullName(test),status:test.result().state}));
    const row = {at:Date.now(),kind:'module',file:module.moduleId.replace(/^\/work\//,''),status:module.state(),errors:module.errors().length,errorDetails:module.errors().map(error=>({message:error.message,stack:error.stack})),tests};
    appendFileSync(process.env.GATE_IDS.replace(/\.ids\.jsonl$/,'.modules.jsonl'),JSON.stringify(row)+'\n');
  }
  onTestRunEnd(modules, errors, reason) {
    const errorDetails = errors.map(({message,stack,type,vitest_test_path,vitest_test_name}) => ({message,stack,type,vitest_test_path,vitest_test_name}));
    appendFileSync(process.env.GATE_IDS.replace(/\.ids\.jsonl$/,'.modules.jsonl'),JSON.stringify({kind:'run-end',files:modules.length,unhandled_errors:errors.length,errorDetails,reason})+'\n');
  }
}
