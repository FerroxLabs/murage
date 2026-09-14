/** One ephemeral owner claim closes dispatch admission before desktop shutdown. */
export function createBackupRestartAdmission(host: { isBusy: () => boolean; onRelease: () => void }) {
  let heldToken: string | null = null;
  const fail=(code:string):never=>{throw Object.assign(new Error(code),{code,status:409});};
  const token=(value:string)=>{if(!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(value))fail("INVALID_BACKUP_RESTART_TOKEN");};
  return {
    held:()=>heldToken!==null,
    prepare(value:string){
      token(value);
      if(heldToken===value)return{prepared:true,token:value};
      if(heldToken)fail("BACKUP_RESTART_ALREADY_PREPARED");
      let busy=true;try{busy=host.isBusy();}catch{fail("BACKUP_ACTIVITY_UNAVAILABLE");}
      if(busy)fail("BACKUP_WORK_ACTIVE");
      // No await between the activity read and claim publication.
      heldToken=value;return{prepared:true,token:value};
    },
    cancel(value:string){
      token(value);if(!heldToken)return{released:false};
      if(heldToken!==value)fail("BACKUP_RESTART_TOKEN_MISMATCH");
      heldToken=null;host.onRelease();return{released:true};
    },
    assertOpen(){if(heldToken)fail("BACKUP_RESTART_PREPARED");},
  };
}
