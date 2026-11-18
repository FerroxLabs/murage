// Configuration must not load the Box relay's response/database dependency graph.
export function isCloudHome(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.MURAGE_CLOUD_ROLE === "home";
}
