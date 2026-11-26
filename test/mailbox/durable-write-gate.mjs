export function durableWriteGate(fs, target, side) {
  return {
    ...fs,
    renameSync(source, destination) {
      if (destination === target && side === "before") process.kill(process.pid, "SIGKILL");
      fs.renameSync(source, destination);
      if (destination === target && side === "after") process.kill(process.pid, "SIGKILL");
    },
  };
}
