// SPDX-License-Identifier: AGPL-3.0-or-later
import { appendFileSync } from 'node:fs';
export default class ProgressReporter {
  onTestModuleCollected(module) { for (const test of module.children.allTests()) this.emit('collected',test); }
  onTestCaseReady(test) { this.emit('running',test); }
  onTestCaseResult(test) { this.emit(test.result().state,test,test.result().errors); }
  emit(status,test,errors) {
    if (!process.env.TEST_TRUTH_PROGRESS) return;
    const names=[test.name]; for(let parent=test.parent;parent&&parent.type!=='module';parent=parent.parent)names.unshift(parent.name);
    appendFileSync(process.env.TEST_TRUTH_PROGRESS,JSON.stringify({status,file:test.module.moduleId,fullName:names.join(' '),errors})+'\n');
  }
}
