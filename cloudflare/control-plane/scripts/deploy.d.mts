export const WRANGLER_VERSION: string;
export function plan(argv: string[], processEnv?: Record<string, string | undefined>): { problems: string[]; target?: string; command?: string; args?: string[] };
export function deploy(argv: string[], io: {
  env?: Record<string, string | undefined>;
  readConfig(): string;
  run(command: string, args: string[]): number;
  log(message: string): void;
  error(message: string): void;
}): number;
