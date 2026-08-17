# Receipts

Every completion attempt writes a receipt to `.molt/receipts/`, including —
especially — the refused ones.

```
.molt/receipts/
  0000-refused.md
  0001-refused.md
  0002-accepted.md
```

## What is in one

- **When**, which provider, which model, session token count
- **How many batches of context had been shed** at that point
- **The claim**, verbatim: exactly what the model said when it thought it was done
- **A table of every check**: name, kind, command, exit code, verdict, duration
- **The real output of every check**, not just the verdict

## Why refusals are kept

A record containing only successes has the same shape as a record that was
curated, and it is worth exactly as much. The refusals are the evidence that
molt did not take the model's word for it — they are the part that makes the
acceptances mean something.

## What to do with them

**Review the receipt, not the diff.** On a task with a real bar, the receipt
tells you which conditions were verified and with what evidence. That is a
faster and more honest read than scanning a diff for problems you would need
to already suspect.

**Grep them.** They are markdown with a stable structure:

```bash
grep -l 'FAIL' .molt/receipts/*.md          # everything that was refused
grep -h '^- model:' .molt/receipts/*.md     # which models were used
ls .molt/receipts | grep -c refused         # how often this project's agent lied
```

That last number is worth watching over time. It is the local version of the
false-completion rate — and it is a property of the model you are running, not
of molt.

## Committing them

Receipts are gitignored by default, because they are session artifacts and they
accumulate. Teams that want an audit trail should commit them deliberately, or
archive them somewhere with a retention policy — a receipt is only evidence for
as long as it exists.
