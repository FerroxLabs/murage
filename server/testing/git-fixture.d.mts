export interface GitFixture {
  root: string;
  env: NodeJS.ProcessEnv;
  git(...args: string[]): string;
  dispose(): void;
}
export function gitFixture(files?: string[], options?: { sourceRoot?: string }): GitFixture;
