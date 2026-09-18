/** Carry out a pending action once the user has said OK (see pending.ts). */
import { AgentGrid, formatOrchestrator, type AgentStart } from "./agentgrid.js";
import { sharedBrowser, type AssistantBrowser, type Element } from "./browser.js";
import { macOpen, performOpen, type OpenAction, type Runner } from "./open.js";
import type { Pending } from "./pending.js";
import { performTicketChange, type TicketChange } from "./tickets.js";
import { classifyCommand, formatResult, runCommand, runVisible, type CommandRequest, type Shell } from "./terminal.js";

export interface PerformDeps {
  run?: Runner;
  shell?: Shell;
  agentGrid?: AgentGrid;
  browser?: AssistantBrowser;
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
      return (deps.agentGrid ?? new AgentGrid()).start(p.payload as AgentStart);
    }
    case "agent-message": {
      const m = p.payload as { sessionId: string; title: string; message: string };
      await (deps.agentGrid ?? new AgentGrid()).message(m.sessionId, m.message);
      return `Sent to ${m.title}.`;
    }
    case "orchestrator-start": {
      const { id, goal } = p.payload as { id: string; goal: string };
      return formatOrchestrator(await (deps.agentGrid ?? new AgentGrid()).startOrchestrator(id, goal));
    }
    case "orchestrator-stop": {
      const { id, reason } = p.payload as { id: string; reason?: string };
      return formatOrchestrator(await (deps.agentGrid ?? new AgentGrid()).stopOrchestrator(id, reason));
    }
    case "orchestrator-send": {
      const { id, name, text } = p.payload as { id: string; name: string; text: string };
      await (deps.agentGrid ?? new AgentGrid()).sendOrchestrator(id, text);
      return `Sent to ${name}.`;
    }
    case "orchestrator-approval": {
      const { id, approvalId, approved, reason } = p.payload as { id: string; approvalId: string; approved: boolean; reason?: string };
      return formatOrchestrator(await (deps.agentGrid ?? new AgentGrid()).answerOrchestrator(id, approvalId, approved, reason));
    }
    case "ticket":
      return performTicketChange(p.payload as TicketChange, deps.agentGrid ?? new AgentGrid());
    case "browser-site": {
      const { url } = p.payload as { url: string };
      const browser = deps.browser ?? sharedBrowser();
      const site = browser.allow(url);
      return `Added ${site} to the browser's site list.\n${await browser.open(url)}`;
    }
    case "browser-act": {
      const a = p.payload as { action: "click" | "type"; element: Element; url: string; text?: string; submit?: boolean };
      const browser = deps.browser ?? sharedBrowser();
      const el = await browser.again(a.element, a.url);
      return a.action === "click" ? browser.click(el) : browser.type(el, a.text ?? "", Boolean(a.submit));
    }
    default:
      throw new Error(`Don't know how to do "${p.kind}".`);
  }
}
