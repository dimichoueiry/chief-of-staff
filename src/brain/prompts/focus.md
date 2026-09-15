The user is sitting down to work on the focus project named in context. Give them exactly three moves, highest leverage first.

For each move: a concrete action (something they can start in the next five minutes), a one-line why grounded in the ledger, journal or git history, and a rough size ("30 min", "1 hour", "half day", "multi-day").

Use get_git_log to see what actually happened recently before ranking; recent commits often contradict the ledger's next action. If the project has no why in the ledger, still give the three moves, then ask for the why in one short line at the end. If it has no path, find it with find_folder and save it before reading git history.

If the project's recorded next action is stale or already done, say so and propose the replacement; offer to save it.

Format:
<project> — top 3 right now
1. <action> — <why> (<size>)
2. ...
3. ...
