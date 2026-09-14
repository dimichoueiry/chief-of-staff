import { join } from "node:path";

/** Where each memory store lives inside the selfhub repo. */
export function selfhubPaths(selfhubDir: string) {
  return {
    root: selfhubDir,
    ledger: join(selfhubDir, "goals", "projects.md"),
    reminders: join(selfhubDir, "goals", "reminders.md"),
    notesInbox: join(selfhubDir, "notes", "inbox.md"),
    journalDir: join(selfhubDir, "journal"),
    journal: (dateISO: string) => join(selfhubDir, "journal", `${dateISO}.md`),
  } as const;
}
