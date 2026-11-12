import "node:child_process";

// Node's fork() forwards its options to spawn(), including windowsHide. The
// pinned @types/node ForkOptions omits that supported pass-through flag even
// though SpawnOptions declares it. Keep real fork launches explicit and typed.
declare module "node:child_process" {
  interface ForkOptions {
    windowsHide?: boolean | undefined;
  }
}
