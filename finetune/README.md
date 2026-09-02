# Training molt's safeguard

A small model, fine-tuned on molt's own record, that **proposes** what the bar
will say and never decides it. The bar is the judge; this is the lab partner
that says "you are about to be refused for line 77" before the claim, points
at the citation `grep` will check, and proposes the next bypass to try.

The one rule, from `docs/commandments.md`: a model may find, localise and
propose; a mechanical check renders the verdict. Nothing this model emits
carries an `ok` field, and nothing it says appears on a receipt.

## Where the data comes from

molt writes a labelled example every time it judges a claim, and the label is
mechanical:

| artifact | holds | used for |
|---|---|---|
| `.molt/receipts/*.md` | claim verbatim, files changed, every check's output, verdict | the target |
| `.molt/log/*.jsonl` | every tool call in order, permissions, bar runs, hash-chained | the input |
| `.molt/exuviae/*.md` | full transcripts that were shed | context, when present |
| `--capture <dir>` | **one JSON per attempt: the whole wire transcript, ledger, bar result** | the input, in full, going forward |

The journal deliberately records no message content, so historical data
carries the tool-call *sequence* but not the conversation. `molt run
--capture finetune/captures` (or `MOLT_CAPTURE_DIR`) records the full,
redacted transcript per attempt from now on. Off by default: a transcript on
disk is the file that quietly accumulates credentials.

## Build the dataset

```sh
node finetune/extract.mjs --out finetune/data/$(date +%F) . ../other-project ~/scratch/copy
```

Reads every root's `.molt/`, deduplicates attempts by receipt hash (copies of
a project do not count twice), joins each receipt to its journal turn, and
splits **by session** so attempts that share a transcript never straddle
train and valid. Writes:

- `records.jsonl` — one structured row per unique attempt, with provenance
  (root, receipt file, receipt sha256, session, journal entry range).
- `train.jsonl`, `valid.jsonl` — mlx-lm chat format for the refusal-predictor
  target. `*.provenance.jsonl` beside each, line for line.
- `manifest.json` — counts, verdict and failing-check distribution, split.

Nothing is invented: a field the record does not hold is absent.

### The first target: refusal prediction

Input: task, model, tool calls in order, files changed, the claim, the checks
that will run. Output: the bar's verdict and, for a refusal, each failing
check's first lines. A model that learns this predicts molt; it does not
replace it. Every prediction is adjudicated by the bar that follows, and every
disagreement is the next training example.

Later targets, same discipline: citation extraction for commandment 6 (the
model pulls `(file, quoted line)` pairs, `grep` decides), route detection
("scratch script then `node scratch.cjs`"), criteria drafting, and the red
team (propose a bypass; the bar says whether it worked).

## Which model

Measured on this machine: Apple M5, 24 GB unified memory, mlx-lm 0.31.3.

| model | params | licence | why / why not |
|---|---|---|---|
| **Qwen3-4B** | 4.0B | Apache-2.0 | First choice. Strong on code, mature mlx-lm support, 4-bit weights at ~3.4 GB, 32K context. Train with thinking off; the targets are terse. |
| Gemma 4 E4B | 4.5B effective (PLE; more on disk) | Gemma terms | Second. Newest of the three, 128K context, strongest per effective parameter in 2026 comparisons. Larger footprint than the "4B" suggests; check mlx-lm's Gemma 4 support before committing. |
| Phi-4-mini-instruct | 3.8B | MIT | Fine fallback. Edges Qwen3-4B on one structured-extraction benchmark (F1 0.95 vs 0.93), weaker on code. |

"Gemma 4 7B that only takes 3–4B" is the E4B: per-layer embeddings make the
total parameter count larger than what runs per token.

All three fit 24 GB for LoRA with room to spare; a 4B model in bf16 is ~8 GB.

## Train

```sh
uv venv finetune/.venv && uv pip install --python finetune/.venv/bin/python mlx-lm
finetune/.venv/bin/python -m mlx_lm.lora \
  --model mlx-community/Qwen3-4B-4bit \
  --train --data finetune/data/2026-09-02 \
  --fine-tune-type lora --num-layers 16 --batch-size 2 --iters 600 \
  --learning-rate 1e-5 --mask-prompt \
  --adapter-path finetune/adapters/qwen3-4b-v0
finetune/.venv/bin/python -m mlx_lm.lora --model mlx-community/Qwen3-4B-4bit \
  --adapter-path finetune/adapters/qwen3-4b-v0 --data finetune/data/2026-09-02 --test
```

`--mask-prompt` trains on the verdict only, not on reproducing the prompt.
Fifty examples is a smoke test, not a model; 2,000–5,000 is where LoRA earns
its keep. `finetune/generate.sh` makes more: real runs against a cheap
provider, captured in full, labelled by the bar.

## Two traps, both hit on the first run

- **NaN loss with `--mask-prompt`.** mlx-lm divides the loss by the number of
  target tokens. A prompt longer than `--max-seq-length` is truncated from the
  end, the target goes with it, the count is zero, and one 0/0 poisons the
  adapter for every step after — the first smoke run "trained" 20 iterations
  and saved weights with NaN loss throughout. The extractor now caps every
  rendered prompt, and `manifest.json` records the longest example; set
  `--max-seq-length` above it and check the first report line is a number.
- **Metal out-of-memory.** A 4B model at 4-bit with a 6144 window ran out of
  the 24 GB while molt runs shared the machine. `--grad-checkpoint` brought
  the peak from 10 GB to 5.8 GB at 4096.

Measured, 2026-09-02, Qwen3-4B-4bit, 60 iterations on 45 rows: validation
loss 9.53 → 1.27 → 0.90. Fifty rows learn the *format*; nothing about that
number says the model predicts verdicts. The held-out set is five examples.

## Evaluate the way molt evaluates

- Held-out **sessions**, never rows.
- Precision and recall of predicted failing checks against the bar's real
  verdict, per check.
- Every miss is logged beside the bar's verdict in the journal, and becomes
  the next training row. A safeguard whose disagreements are recorded is a
  safeguard; one whose agreements are trusted is a liability.
