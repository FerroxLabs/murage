import type { PublishRequest } from "../email/restore-job-effects.ts";
import type { RestoreJobEffects } from "../email/restore-job.ts";
export function rowFromRequest(req: PublishRequest, identity: {dev:string;ino:string}) {
  return {id:1,job_id:req.jobId,cause:req.cause,elapsed_ms:req.elapsedMs,outcome:req.outcome,at:req.at,boot_id:req.bootId,up_ms:req.upMs,db_dev:identity.dev,db_ino:identity.ino};
}
export function rowBackedEffects(base: RestoreJobEffects, row: Record<string, unknown> | null, opts: {prepared?:string;dev?:string;ino?:string} = {}): RestoreJobEffects {
  return {...base,bootWait:()=>({row,prepared:opts.prepared ?? base.marks().prepared,dev:opts.dev ?? "1",ino:opts.ino ?? "2"})};
}
