# molt

```
(m)(o)(l)(t)  →  m(o)(l)(t) )  →  mo(l)(t) ))  →  molt ))))
```

**A tiny agent harness with a bill of materials.** Any OpenAI-compatible
API — local llama.cpp/Ollama/vLLM, OpenRouter, OpenAI, Groq — three tools,
a ~40-token system prompt, hard token budgets, and permission gates. The
whole thing is small enough to read before dinner.

> Not affiliated with, endorsed by, or sponsored by Anthropic, OpenAI, or
> any model provider. molt is an independent open-source harness.

## The molt: compaction that loses nothing

The most-hated behavior in every big agent CLI is auto-compaction: it
fires mid-task without consent, replaces your history with a
model-written summary that hallucinates, and destroys the original —
lossy compression on lossy compression until the work is gone.

molt inverts every part of that:

- **You trigger it.** `/shed` — never automatic, never mid-task.
- **It's mechanical, not model-written.** The digest is deterministic
  verbatim excerpts: your requests, the results, the actions taken.
  Zero tokens spent to save tokens. Zero hallucination surface.
- **Nothing is destroyed.** The full unabridged history is written to
  `.molt/exuviae/<timestamp>.md` — the shed skin, kept. `/regrow`
  re-attaches it whole.
- **You see the diff.** `shed 6 messages · history 900→120 tok (est) ·
  0 tokens spent · full copy: .molt/exuviae/...`
- **It refuses bad sheds.** If the digest wouldn't shrink context, molt
  declines and changes nothing (no-gain guard).

That's what the name means. Arthropods don't summarize their old shell
— they shed it whole and leave it intact.

## Why molt exists

Every harness tells you it's efficient. molt **shows you the invoice**:

- `/bom` — the context bill of materials before every request: system
  prompt tokens, tool schema tokens, history tokens, estimated total
- Every turn ends with a receipt: `✓ 900→80 tok · session 980 · $0.0123`
- `/budget 50000` — a **hard stop**, enforced in the loop, not a vibe
- Tool results are byte-capped (4KB) with the truncation shown inline
- Startup prints the measured system prompt size — no hidden overhead

And it ships the safety layer minimal harnesses tell you to build
yourself: `bash` and `write_file` are gated behind y/n prompts by
default. Reads are free.

## Quick start

```bash
npm install && npm start        # defaults to local Ollama ($0 path)
```

Keys and models work Pi-style, all in-session:

```
/login       pick a provider (openrouter · anthropic · openai · xai · groq)
             → paste key (masked) → saved. repeat to add more providers.
/model       one aggregated list of every model across ALL your keys
             (+ local ollama if it's running) → pick by number or name →
             molt switches endpoint + key + model in one move
/doctor      verify before you spend a token
```

Endpoint + model persist to `~/.config/molt/config.json`, keys per
provider to `~/.config/molt/auth.json` (0600, plaintext — same
trade-off as most CLIs; keychain is roadmap). Next launch resumes where
you left off. `/connect <provider>` still exists for direct switching,
and env vars / flags always win:

| env | meaning | default |
|---|---|---|
| `MOLT_BASE_URL` | OpenAI-compatible base URL | `http://localhost:11434/v1` |
| `MOLT_API_KEY` | bearer key (omit for local) | — |
| `MOLT_MODEL` | model name | `qwen2.5-coder:14b` |
| `MOLT_PRICE_IN/OUT` | $ per 1M tokens, enables $ display | — |

Local-first by default: pointed at your own GPU, the receipt reads $0.

## The shell

- Live molting: `/molt tidepool|ember|mantis|mono` re-skins mid-session;
  the banner sheds its husks again in the new palette
- User themes: partial `~/.config/molt/theme.json` loads as `custom`
- Slash commands: `/shed` `/regrow` `/bom` `/wire` `/budget [tok]`
  `/race <m1> <m2>` `/molt [theme]` `/new` `/help` `/quit`
- `/wire` — dumps the exact JSON of the last request to `.molt/wire.json`.
  No harness hides the wire from you here.
- `/race qwen2.5-coder:14b llama3.3:70b` — the next prompt runs on each
  model as an isolated tool-less probe with per-model receipts (tokens,
  wall time) and a fastest/leanest comparison. Built for picking the
  right local model before you spend a session on the wrong one.

## Measured, not claimed (R&D results)

The shed lab (`npm run lab`) simulates 120-turn sessions and audits the
losslessness claim:

```
shed cycles: −25% to −75% history tokens per shed, <3ms, 0 model calls
fact audit:  120/120 seeded facts recoverable (23 live, 97 in exuviae, 0 LOST)
perf:        bom() 0.18ms avg and shed() 2.7ms on a 1000+ message history
```

Integration stress tests run the real engine over real HTTP against an
adversarial mock provider (`rnd/mock-server.mjs`): a genuine 3-step
read→write→run coding task, 200KB CJK/emoji responses, missing usage
fields, non-JSON 200s, HTTP 500/429, sockets destroyed mid-response,
tool-spam loops, and slow providers — all handled without a crash.

Red-team hardening that came out of this pass:
- **bash child env is scrubbed of provider keys** — a prompt-injected
  `env` can no longer read your API key back into context (verified on
  the wire)
- **reads outside the working directory hit the permission gate** —
  `~/.ssh`, `/etc`, dotfiles are no longer silently readable; reads
  inside cwd stay frictionless
- **bash timeout is enforced and reported** (`timeout` tag, configurable)

## Development

```bash
npm run typecheck && npm test   # 44 tests incl. real-HTTP integration suite, run in CI
```

The engine is fuzzed against hostile providers (non-JSON, missing
choices, HTTP errors, runaway tool loops), the reducer against unknown
event kinds, and the Ink layer is driven by synthetic streams — the UI
layer is the defect hotspot in every big CLI, so it's the layer molt
tests hardest.

## Architecture (4 source files)

```
src/engine.ts      the loop: OpenAI-compat wire, 3 tools, budgets, BOM
src/transcript.ts  pure event→line reducer
src/app.tsx        Ink component; engine injectable for tests
src/cli.tsx        env config + entrypoint
src/banner.tsx     the shed
```

## What molt is not

- Not a Claude Code replacement — no subagents, MCP, plan mode, or
  compaction. See [COMPARISON.md](./COMPARISON.md) for the honest map.
- Not streaming (yet) — turns render complete; reliability first.
- Not sandboxed — gates ask you; they don't containerize. Run it in a
  container if you point it at anything you can't lose.

## License

MIT
