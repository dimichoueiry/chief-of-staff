/** Carry out a pending action once the user has said OK (see pending.ts). */
import { AgentGrid } from "./agentgrid.js";
import { sharedBrowser, type AssistantBrowser, type Element } from "./browser.js";
import { macOpen, performOpen, type OpenAction, type Runner } from "./open.js";
import type { Pending } from "./pending.js";
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
      const job = p.payload as { task: string; folder?: string; engine?: "claude" | "codex"; name?: string; visible?: boolean };
      return (deps.agentGrid ?? new AgentGrid()).start(job);
    }
    case "agent-message": {
      const m = p.payload as { sessionId: string; title: string; message: string };
      await (deps.agentGrid ?? new AgentGrid()).message(m.sessionId, m.message);
      return `Sent to ${m.title}.`;
    }
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
