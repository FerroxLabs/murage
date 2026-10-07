// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright 2026 Ferrox Labs
export function projectDecisionSentence(name: string, count: number): string {
  return `${name}: ${count} ${count === 1 ? "thing needs" : "things need"} your OK`;
}
export class ProjectDecisionReminders {
  private readonly groups=new Map<string,{since:number;reminded:boolean}>();
  due(groupId:string, ids:readonly string[], now:number):boolean {
    if(!ids.length){this.groups.delete(groupId);return false;}
    let state=this.groups.get(groupId);
    if(!state){state={since:now,reminded:false};this.groups.set(groupId,state);}
    if(state.reminded || now-state.since<600000)return false;
    state.reminded=true;return true;
  }
}
