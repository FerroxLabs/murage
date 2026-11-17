export interface WindowsUnsignedPePin { bytes:number; sha256:string; checksum:number }
export function unsignedWindowsPePin(bytes:Buffer):WindowsUnsignedPePin;
export function verifySignedWindowsPe(bytes:Buffer,pin:WindowsUnsignedPePin):void;
export function hasEmbeddedWindowsPeSignature(bytes:Buffer):boolean;
