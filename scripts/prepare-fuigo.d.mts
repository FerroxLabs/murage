export type FuigoAsset = Readonly<{ package: string; tarballSha256: string; binarySha256: string }>;
export declare const FUIGO_VERSION: string;
export declare const FUIGO_ASSETS: Readonly<Record<string, FuigoAsset>>;
