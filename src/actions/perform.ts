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
      const out = a.action === "click" ? await browser.click(el) : await browser.type(el, a.text ?? "", Boolean(a.submit));
      const dialog = browser.dialog();
      if (!dialog) return out;
      // Without this the model is told the deletion is done, sees a box in the way, and closes it.
      const name = dialog.name ? `\u201c${dialog.name}\u201d` : "a dialog";
      return [
        `The click landed, and the site answered with ${name}: it is asking before it does the thing, so ${p.label} has NOT happened yet.`,
        "Do not close or dismiss it. Read it, and ask them in one short sentence about the button that goes through with it.",
        out,
      ].join("\n");
    }
    default:
      throw new Error(`Don't know how to do "${p.kind}".`);
  }
}
