export const LAUNCH_SECRET_MESSAGE: string;
export function launchSecretVia(name: string, transport: "stdin" | "parent"): Record<string, string>;
export function feedLaunchSecretStdin(child: { stdin?: NodeJS.WritableStream | null }, value: string): void;
export function sendLaunchSecretParent(proc: { postMessage(message: unknown): void }, name: string, value: string): void;
