export function e2eEnvironment(
  base: NodeJS.ProcessEnv,
  dataDir: string,
  execPath?: string,
): NodeJS.ProcessEnv & { HOME: string; MURAGE_DATA_DIR: string };
