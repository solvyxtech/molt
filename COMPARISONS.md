# Comparisons

Honest differences. molt does not invent completion gates — it makes the bar a committed file, judges the real disk, and writes a receipt either way.

| Tool / pattern | What it already does well | What molt adds |
|---|---|---|
| **Claude Code Stop hooks** | Can block a turn and push stderr back to the model when a command fails | Default bar is a committed `.molt/done.yml`. Disk judgment (before/after hashes on writes). Receipts for accepts **and** refusals. |
| **Aider / similar CLI agents** | Strong edit loops over a repo | Acceptance lives outside the model. Hash-chained journal you can recompute with `molt verify`. |
| **Cursor / IDE agents** | Great UX for edits and review | Same proof engine in a terminal UI and a desktop window. Proof is the product, not a plugin. |
| **CI alone** | Catches broken main after the fact | Gates the agent mid-turn, before “done” is accepted, against the tree the agent just wrote. |

If you already gate Claude Code on your suite via Stop hooks, you have most of the loop. molt’s bet is the committed bar, the disk ledger, and one receipt per attempt.

See also: [README](README.md) · [Studio](https://solvyx.xyz/work/molt)
