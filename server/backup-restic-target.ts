import { z } from "zod";
const reference=z.string().min(1).max(120).regex(/^[A-Za-z0-9][A-Za-z0-9_-]*$/);
const endpoint=z.string().max(2048).refine(value=>{try{const url=new URL(value);return url.protocol==="https:"&&!url.username&&!url.password&&!url.search&&!url.hash&&url.pathname==="/"&&url.origin===value&&!/[\s\\]/.test(value);}catch{return false;}},"Invalid S3 endpoint");
export const resticS3TargetSchema=z.object({kind:z.literal("s3"),remoteRef:reference,revision:z.number().int().nonnegative(),credentialRef:reference,endpoint,bucket:z.string().min(3).max(63).regex(/^[a-z0-9][a-z0-9.-]*[a-z0-9]$/).refine(value=>!value.includes("..")&&!/^\d+\.\d+\.\d+\.\d+$/.test(value)),prefix:z.string().min(1).max(512).refine(value=>value.split("/").every(part=>/^[A-Za-z0-9_-][A-Za-z0-9_.-]*$/.test(part)&&part!=="."&&part!=="..")),region:z.string().min(1).max(64).regex(/^[A-Za-z0-9_-]+$/),bucketLookup:z.enum(["auto","path","dns"])}).strict();
export type ResticS3Target=z.infer<typeof resticS3TargetSchema>;
const secret=z.string().min(1).max(4096).refine(value=>!/[\r\n\0]/.test(value));
export const resticS3CredentialsSchema=z.object({accessKeyId:secret,secretAccessKey:secret,sessionToken:secret.optional()}).strict();
export type ResticS3Credentials=z.infer<typeof resticS3CredentialsSchema>;
export interface ResticS3Run {repository:string;region:string;bucketLookup:ResticS3Target["bucketLookup"];credentials:ResticS3Credentials}
export function resticS3Repository(target:ResticS3Target){return `s3:${target.endpoint}/${target.bucket}/${target.prefix}`;}
/** A dedicated child environment, never a merge with process.env. */
export function resticChildEnvironment(cwd:string,s3?:ResticS3Run):Record<string,string>{
  const env:Record<string,string>={HOME:cwd,PATH:"",TMPDIR:cwd};if(!s3)return env;
  try{
    if(!s3.repository.startsWith("s3:https://"))throw Error();const url=new URL(s3.repository.slice(3)),parts=url.pathname.slice(1).split("/");
    const target=resticS3TargetSchema.parse({kind:"s3",remoteRef:"runner",revision:0,credentialRef:"runner",endpoint:url.origin,bucket:parts.shift(),prefix:parts.join("/"),region:s3.region,bucketLookup:s3.bucketLookup});
    if(resticS3Repository(target)!==s3.repository)throw Error();const credentials=resticS3CredentialsSchema.parse(s3.credentials);
    Object.assign(env,{RESTIC_REPOSITORY:s3.repository,AWS_DEFAULT_REGION:s3.region,AWS_ACCESS_KEY_ID:credentials.accessKeyId,AWS_SECRET_ACCESS_KEY:credentials.secretAccessKey});if(credentials.sessionToken)env.AWS_SESSION_TOKEN=credentials.sessionToken;return env;
  }catch{throw Error("RESTIC_S3_CREDENTIALS_INVALID");}
}
