# molt dogfood protocol (v0.5)

Goal: validate the one claim no CI can — that a real local model stays
coherent after `/shed`. Everything below runs on a single 3090-class GPU.

## Setup (5 min)

```bash
ollama pull qwen2.5-coder:14b        # or your daily driver
git clone <repo> && cd molt && npm install
npm start                            # defaults to localhost Ollama
/doctor                              # must say: endpoint reachable · '...' available
# cloud instead? → /login (pick provider, paste key) → /model (pick from all) → /doctor
```

## Scenarios — run in order, keep the receipts

**S1 — smoke (5 min).** In a scratch git repo: "create fib.py with an
iterative fibonacci and run it." Expect: gated write (y), gated bash (y),
receipt line. Record: the `✓ … tok` line.

**S2 — the shed test (30+ min). This is the launch-critical one.**
Work a real multi-file task until `/bom` shows history > 6–8k tok.
Then: note 3 specific facts the model currently knows (a file path, a
decision, an error message). Run `/shed`. Continue the task with a
prompt that *requires* those facts but doesn't restate them.
- PASS: model proceeds correctly, or asks a targeted question.
- FAIL: model hallucinates or re-does completed work.
Record: the shed receipt, the exuvia file, and the model's first
post-shed response, verbatim. This becomes launch-post evidence either way.

**S3 — regrow (5 min).** After S2, run `/regrow`, then ask a question
answerable only from the shed history. PASS: answered from re-attached
context.

**S4 — race (10 min).** `/race qwen2.5-coder:14b llama3.3:70b` (or any
two pulled models), then a representative planning prompt. Record the
comparison line. This is your model-shopping demo.

**S5 — budget (2 min).** `/budget 2000`, then a task that needs several
tool round-trips. PASS: hard stop with the budget error, session tokens
≤ ~budget + one turn.

**S6 — gates (2 min).** Ask it to "read /etc/hostname and summarize."
PASS: permission prompt appears (outside-cwd read). Deny it; model
should adapt.

## Known gaps to watch (not bugs)

- No streaming: long turns sit on "thinking…" — note how bad this feels
  at 14B speeds; it decides whether streaming is v0.6.
- Digest quality: `/shed` keeps 300-char excerpts; if S2 fails, the fix
  is likely digest tuning (keep more of the *last* dropped exchange).
- Small-model tool discipline: if qwen-14b emits malformed tool args,
  molt runs with empty args — watch for `⚙` lines with blank details.

## What "ready to launch" means

S1, S3, S5, S6 pass mechanically. S2 passes on at least 2 of 3 runs
with the model you'll demo. Then record the S2 session as the GIF/video
and drop its numbers into docs/launch-post.md.
