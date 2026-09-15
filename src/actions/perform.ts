/** Carry out a pending action once the user has said OK (see pending.ts). */
import { AgentGrid } from "./agentgrid.js";
import { macOpen, performOpen, type OpenAction, type Runner } from "./open.js";
import type { Pending } from "./pending.js";
import { classifyCommand, formatResult, runCommand, runVisible, type CommandRequest, type Shell } from "./terminal.js";

export interface PerformDeps {
  run?: Runner;
  shell?: Shell;
  agentGrid?: AgentGrid;
}

export async function performPending(p: Pending, deps: PerformDeps = {}): Promise<string> {
  switch (p.kind) {
    case "open":
      return performOpen(p.payload as OpenAction, deps.run ?? macOpen);
    case "command": {
      const req = p.payload as CommandRequest;
      // Checked again: an OK never unlocks what is never allowed.
      const { level, reason } = classifyCommand(req.command);
      if (level === "blocked") throw new Error(`Refused: ${reason}.`);
      if (req.visible) return runVisible(req, deps.run ?? macOpen, { confirmed: true });
      return formatResult(await runCommand(req, { shell: deps.shell, confirmed: true }));
    }
    case "agent-start": {
      const job = p.payload as { task: string; folder?: string; engine?: "claude" | "codex"; name?: string; visible?: boolean };
      return (deps.agentGrid ?? new AgentGrid()).start(job);
    }
    case "agent-message": {
      const m = p.payload as { sessionId: string; title: string; message: string };
      await (deps.agentGrid ?? new AgentGrid()).message(m.sessionId, m.message);
      return `Sent to ${m.title}.`;
    }
    default:
      throw new Error(`Don't know how to do "${p.kind}".`);
  }
}
