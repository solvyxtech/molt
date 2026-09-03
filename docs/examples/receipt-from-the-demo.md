<!--
  The receipt molt wrote for the turn in the README's demo, copied here
  unedited. It was produced by that run and not written for this page: the
  workspace path is the scratch copy the demo ran in.
-->

# molt receipt 0000 — accepted

molt accepted this claim: every check that can block a completion passed.

## What the model claimed

> Fixed `fmtDuration` so sub-second values stay in milliseconds (`1` → `"1ms"`). Added `fmtDuration(1000) === "1s"` so the `< 1000` boundary cannot survive a `<=` mutation.

## What this task had to satisfy

Set before the work began and sealed as `feff7a18877439a6`. The seal is written to
the session journal before the first request, so these can be shown to predate
the work rather than to claim they did.

**Machine-checked.** These ran with the bar and could refuse the claim:

- `task-gate: node -e "import('./dist/session-commands.js').then(m=>{if(m.fmtDuration(1)!=='1ms')process.exit(1)})"`

## What the model changed

| file | before | after |
|---|---|---|
| `src/session-commands.ts` | `a074ca7e1d0f` | `87767c16fa80` |
| `test/loop-close.test.ts` | `4d5e5b567018` | `df490ce46062` |

Hashes are SHA-256, taken immediately before and after molt wrote the file.
`work-landed` re-reads each path and fails if what is there now does not match.

## What the model ran

- read_file .molt/done.yml
- read_file test/loop-close.test.ts
- read_file src/session-commands.ts
- read_file src/format.ts
- grep /fmtDuration/ **/*.{ts,tsx,js}
- grep /fmtDuration/ in test
- grep /"build"|"typecheck"|"test"/ package.json
- read_file src/session-commands.ts from line 51
- edit_file src/session-commands.ts
- bash npm test 2>&1 | tail -80 [capped at 8192B (was 9478B)]
- read_file .molt/done.yml
- list_dir .molt
- read_file src/session-commands.ts from line 56
- read_file src/mutate.ts
- grep /survives mutation|fmtDuration|session-commands/ **/*.{ts,yml,md}
- read_file .molt/done.yml from line 2
- read_file test/loop-close.test.ts from line 121
- read_file README.md from line 121
- read_file test/loop-close.test.ts from line 131
- edit_file test/loop-close.test.ts
- read_file test/loop-close.test.ts from line 126
- edit_file test/loop-close.test.ts
- read_file test/loop-close.test.ts from line 511
- bash npx tsx -e "import { fmtDuration } from './src/session-commands.ts'; console.log(JSON.stringify({1: fmtDuration(1), 999: fmtDuration(999), 1000: fmtDuration(1000), 45000: fmtDuration(45000)}))"
- bash npx tsx --test test/loop-close.test.ts 2>&1 | tail -40
- read_file package.json
- grep /if \(ms < 1000\)/ dist/session-commands.js
- read_file dist/session-commands.js from line 41

## What was checked, and what it established

| check | verdict | what it established | ms |
|---|---|---|---|
| types | pass | `npm run typecheck` exited 0 in 1741ms | 1741 |
| tests | pass | `npm test` exited 0 in 24161ms | 24161 |
| app-boots | pass | `npm run self-check` exited 0 in 8474ms | 8474 |
| app-drives | pass | `npm run e2e` exited 0 in 6255ms | 6255 |
| work-landed | pass | 2 file(s) modified and verified byte-for-byte on disk | 1 |
| record-intact | pass | No context has been shed; nothing to audit. | 0 |
| work-accounted | pass | 2 file(s) changed on disk this turn, every one written through a tool and in the ledger | 19 |
| spec-intact | pass | 1 test file(s) changed, no assertion removed | 5 |
| work-proven | pass | 1 changed file(s) executed by the tests · 1 not in the coverage report (not instrumented — | 6 |
| work-checked | pass | 1 mutation(s) broke a test, as they should · 1 changed line(s) not mutated (sample is 3; r | 23872 |
| task:task-gate | pass | `node -e "import('./dist/session-commands.js').then(m=>{if(m.fmtDuration(1)!=='1ms')proces | 33 |

## Output

### types — pass

check: types
kind: command
command: npm run typecheck
exit: 0
result: pass
ran: yes
duration_ms: 1741

```
`npm run typecheck` exited 0 in 1741ms
```

### tests — pass

check: tests
kind: command
command: npm test
exit: 0
result: pass
ran: yes
duration_ms: 24161

```
`npm test` exited 0 in 24161ms
```

### app-boots — pass

check: app-boots
kind: command
command: npm run self-check
exit: 0
result: pass
ran: yes
duration_ms: 8474

```
`npm run self-check` exited 0 in 8474ms
```

### app-drives — pass

check: app-drives
kind: command
command: npm run e2e
exit: 0
result: pass
ran: yes
duration_ms: 6255

```
`npm run e2e` exited 0 in 6255ms
```

### work-landed — pass

check: work-landed
kind: builtin
command: files-changed
exit: n/a
result: pass
ran: yes
duration_ms: 1

```
2 file(s) modified and verified byte-for-byte on disk
```

### record-intact — pass

check: record-intact
kind: builtin
command: record-intact
exit: n/a
result: pass
ran: yes
duration_ms: 0

```
No context has been shed; nothing to audit.
```

### work-accounted — pass

check: work-accounted
kind: builtin
command: tree-accounted
exit: n/a
result: pass
ran: yes
duration_ms: 19

```
2 file(s) changed on disk this turn, every one written through a tool and in the ledger
```

### spec-intact — pass

check: spec-intact
kind: builtin
command: spec-intact
exit: n/a
result: pass
ran: yes
duration_ms: 5

```
1 test file(s) changed, no assertion removed
```

### work-proven — pass

check: work-proven
kind: builtin
command: diff-covered
exit: n/a
result: pass
ran: yes
duration_ms: 6

```
1 changed file(s) executed by the tests · 1 not in the coverage report (not instrumented — nothing is claimed about them)
```

### work-checked — pass

check: work-checked
kind: builtin
command: mutation
exit: n/a
result: pass
ran: yes
duration_ms: 23872

```
1 mutation(s) broke a test, as they should · 1 changed line(s) not mutated (sample is 3; raise it or accept the bound)
```

### task:task-gate — pass

check: task:task-gate
kind: command
command: node -e "import('./dist/session-commands.js').then(m=>{if(m.fmtDuration(1)!=='1ms')process.exit(1)})"
exit: 0
result: pass
ran: yes
duration_ms: 33

```
`node -e "import('./dist/session-commands.js').then(m=>{if(m.fmtDuration(1)!=='1ms')process.exit(1)})"` exited 0 in 33ms
```

---

## Session

- when: 2026-09-03T17:42:19.808Z
- attempt: 1
- provider: xai
- model: grok-4.6
- session tokens: 208927
- session cost: $0.2733
- shed batches archived: 0
- bar duration: 64627ms

Every check passed. This is the evidence behind that claim.
