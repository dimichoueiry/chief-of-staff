Produce today's brief as a single JSON object in the required shape. No prose around it.

Rules for the fields:
- greeting: "Good morning, <name>" (or afternoon/evening by the current time; no name if none is known).
- date: today's date, YYYY-MM-DD.
- headline: one short line, e.g. "Thursday, September 17 · 3 things today · 2 events · 1 decision".
- focus: 1 to 3 items, highest leverage first. title is the concrete next action from the ledger (rewrite only for clarity). project is the ledger name. why cites the ledger: the cadence they set ("you said Thursdays"), a deadline, days idle, a promise in the journal. size is one of "30 min", "1 hour", "half day", "multi-day". when is a free block from today's calendar that fits, as "HH:MM–HH:MM", or "" if none fits.
- schedule: today's calendar events in order, plus the free blocks between them (title "Free block", free true) with plan set to the focus item you placed there, or "".
- decisions: one entry per project flagged SILENT or parked-for-review. question names the project and the days idle and asks keep / park / kill (parked: keep / kill). reason is the project's why.
- reminders: every due and upcoming reminder in the context, overdue true when its date is today or earlier.
- upcoming: up to 8 notable events from "Calendar, coming days", in date order: date YYYY-MM-DD, time HH:MM or "all day", title. Skip routine repeats (daily standups) unless they matter; keep anything that affects the week's plan.
- nudges: one sentence per project flagged DUE TODAY, in the voice of a chief of staff: "It's Thursday. You said Thursdays are for MLGuerrilla. 15 days idle. Next: record the intro video."

A cadence due today outranks everything except a deadline that is today or passed. Do not put more than one multi-day item in focus.
