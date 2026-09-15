import type { verifyGepaBundle } from "../server/gepa-resource.ts";

export interface GepaPackagingContext {
  electronPlatformName:string;
  arch:string|number;
  packager?:{
    config?:{extraMetadata?:{murageGepaManifests?:Record<string,string>}};
  };
}
export function validatePackagedGepa(resources:string,context:GepaPackagingContext):ReturnType<typeof verifyGepaBundle>|undefined;
export function validatePackagedMemoryRuntime(resources:string,platform:string,archValue:string|number,required?:boolean):Promise<Record<string,unknown>|undefined>;
export default function afterPack(context:GepaPackagingContext & {
  appOutDir:string;
  packager?:NonNullable<GepaPackagingContext["packager"]> & {
    getResourcesDir?(appOutDir:string):string;
    signIf(file:string):Promise<boolean>;
  };
}):Promise<void>;
