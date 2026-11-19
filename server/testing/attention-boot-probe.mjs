// Isolated child only. Observe the coordinator's real return values and accept events over the parent IPC channel.
import { registerHooks } from "node:module";
import { readFileSync } from "node:fs";

registerHooks({
  load(url, context, next) {
    if (!url.endsWith("/server/index.ts")) return next(url, context);
    const source = readFileSync(new URL(url), "utf8");
    const start = "decisionRecoveryOpen = true;";
    if (source.split(start).length !== 2) throw new Error("decision recovery fixture anchor moved");
    const observer = `
      const fixtureEntries = [];
      const register = approvalAttention.register.bind(approvalAttention);
      approvalAttention.register = (scope, entry) => {
        const result = register(scope, entry);
        if (result === "moved") fixtureEntries.push({ scope, entry });
        return result;
      };
      process.on("message", async ({ operation, threadId, requestId }) => {
        try {
          if (operation === "recover") {
            decisionRecoveryOpen = true;
            try { await recover(); } finally { decisionRecoveryOpen = false; decisionRecoveryContexts.clear(); }
          }
          if (operation === "retire") retireInternalTurn(threadId, approvalAttention.current(threadId).generation);
          if (operation === "unbound" || operation === "bound") {
            const target = [...decisionRequestTargets.values()].find(v => v.target.threadId === threadId && v.target.requestId === requestId)?.target;
            const binding = operation === "bound" ? { turnId: target.turnId, providerInstanceId: target.providerInstanceId } : {};
            bus.publish({ type: "request.resolved", threadId, requestId, ...binding, provider: "claude", source: "timeout", behavior: "deny", createdAt: new Date().toISOString() });
          }
          process.send({
            stats: approvalAttention.stats(),
            targets: [...decisionRequestTargets.values()].filter(({target}) => target.threadId === threadId && target.requestId === requestId).map(v => v.terminal),
            current: approvalAttention.current(threadId)?.generation,
            message: askMessageByRequest.get(threadId + ":" + requestId),
            entries: fixtureEntries.filter(({scope}) => scope.threadId === threadId).map(({scope, entry}) => ({
              generation: scope.generation, message: entry.messageId, accepting: scope.accepting, state: approvalAttention.state(scope, entry.key)
            }))
          });
        } catch (error) { process.send({ error: String(error) }); }
      });
    `;
    return { format: "module-typescript", shortCircuit: true, source: source.replace(start, observer + start) };
  },
});
