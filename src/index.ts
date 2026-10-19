import type { ExtensionAPI, ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import { COMMANDS, Controller, safeError } from "./controller";

/** Registration only: OMP executes factories during package validation too. */
export default function ompSync(api: ExtensionAPI): void {
  let controller: Controller | undefined;
  function initialize(ctx: ExtensionContext): Controller | undefined {
    try {
      const next = new Controller(ctx);
      next.start();
      controller = next;
      return next;
    } catch (error) {
      ctx.ui.notify(`Sync could not initialize: ${safeError(error)}. Check the agent sync directory and its permissions.`, "error");
    }
  }
  api.registerCommand("sync", {
    description: "Pair, synchronize, review conflicts, and manage the self-hosted sync broker",
    getArgumentCompletions: prefix => COMMANDS.filter(value => value.startsWith(prefix)).map(value => ({ value, label: value })),
    handler: async (args, ctx) => {
      if (ctx.agent.kind !== "main") return;
      await (controller ?? initialize(ctx))?.command(args, ctx);
    },
  });
  api.on("session_start", async (_event, ctx) => {
    if (ctx.agent.kind !== "main") return;
    await controller?.stop();
    controller = undefined;
    initialize(ctx);
  });
  api.on("session_shutdown", async (_event, ctx) => {
    if (ctx.agent.kind !== "main") return;
    try { await controller?.stop(); } finally { controller = undefined; }
  });
}
