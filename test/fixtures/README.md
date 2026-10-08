# Test fixtures

`lean-replay-*.json`: two real long bench runs, replayed call for call by
`test/lean-sessions.test.ts` to measure where a long session's request
characters go. Both were Mistral Large 4 runs on 2026-10-07 (bench lane
`ml4b`), each shed twice, so their exuviae hold the whole session verbatim:

| fixture | source run | real requests | real prompt tokens |
|---|---|---|---|
| `lean-replay-duration-bug.json` | `ml4b-1/duration-bug-molt-0-a3b` | 94 | 3,055,840 (91.8% cached, $0.40) |
| `lean-replay-perf-pairs.json` | `ml4b-2/perf-pairs-molt-0-a3b` | 81 | 3,188,112 |

- `steps`: every assistant turn (prose and tool calls with their exact
  arguments) and every tool result, recovered from `.maat/exuviae/`. A
  text-only turn (a claim the bar refused) is folded into the next turn's text.
- `tail`: the turns after the last shed, from the run's journal: each call's
  command and its result size only (the replay fills a result of that size).
- `droppedUserMessages`: sizes of the user messages Maat injected (acceptance
  criteria, a bar refusal); the replay runs without a bar, so they are not
  replayed. Together they are under 3 KB per run.

Both runs spent much of their time reading Maat's own installed `dist/` and
bench result files, which is what the tool results contain. Regenerate with the
extractor described in `reports/lean-sessions-study.md`.
