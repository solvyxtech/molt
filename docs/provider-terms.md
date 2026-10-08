# Provider terms

**This is not legal advice.** It describes how Maat Agent connects to third-party
model providers and what that implies for you. Your agreement is with each
provider, not with Maat.

## Who is responsible

Maat Agent (the product built on the molt engine) is independent software. It is
**not affiliated with, endorsed by, or a product of** SpaceXAI (xAI), Anthropic,
OpenAI, OpenRouter, Groq, Mistral, Google, Meta, or any other model vendor named
in the docs or UI.

You must follow each provider’s Terms of Service and Acceptable Use Policy when
you use their APIs, CLIs, or models through Maat. Naming a provider here does
not mean Maat is “ToS-compliant” on your behalf — that is between you and the
provider.

## Bring your own key (BYOK)

Metered API use is **BYOK only**: you supply credentials for an account you
control. Maat does not pool, share, or resell provider access. Do not use Maat
to circumvent a provider’s limits, share one key across unrelated users, or
resell access.

## Grok Build (subscription CLI)

The only subscription CLI Maat drives is **Grok Build**: the official `grok`
CLI over ACP, signed in with **your own** SuperGrok or X Premium+ account. Maat
does not store those subscription credentials. For metered xAI use, point at
`https://api.x.ai/v1` with your own API key instead.

Useful xAI references (check the live pages for current text):

- [Terms of Service — Consumer](https://x.ai/legal/terms-of-service)
- [Terms of Service — Enterprise](https://x.ai/legal/terms-of-service-enterprise)
- [Acceptable Use Policy](https://x.ai/legal/acceptable-use-policy)

## OpenCode Zen (`opencode://zen`)

Maat can run the official `opencode` CLI as a worker or judge, for **OpenCode
Zen models only** (`opencode/...`, e.g. the free Big Pickle). The owner has
confirmed the OpenCode free tier (Big Pickle and the other free `opencode/*`
Zen models) is OK for Maat as worker or judge, and for fine-tune data.

OpenCode can also sign in to other vendors' consumer plans (Anthropic, GitHub
Copilot, Gemini, ...). Maat never routes through them: any model id that is
not `opencode/...` is refused at parse time and at run time, the config Maat
hands the CLI enables only the `opencode` provider, and other providers'
credentials are scrubbed from its environment. `opencode://subscription` is
the deprecated old name, accepted for one release.

## Subscription CLIs that are not supported

Claude Code, Gemini CLI, and Antigravity subscription backends have been
**removed** and are unsupported. Do not expect Maat to drive those CLIs or to
use their subscription logins.

Anthropic Console API keys (metered) remain supported via the Anthropic /
OpenAI-compatible endpoints. Anthropic’s own rules disallow using consumer
subscription logins inside third-party tools — use a Console key, not a
Claude.ai session.

## Other API providers

Same BYOK rule. Useful starting points (not exhaustive; providers change URLs):

- [Anthropic Commercial Terms](https://www.anthropic.com/legal/commercial-terms)
- [OpenAI Services Agreement](https://openai.com/policies/services-agreement/)
- [OpenRouter Terms of Service](https://openrouter.ai/terms)

Groq, Mistral, and similar OpenAI-compatible hosts: use your own key and their
published terms.

## Local runtimes

Ollama, llama.cpp, vLLM, and similar local servers: the **runtime software** is
typically under a permissive licence. The **model weights** you load are under
whatever licence the model publisher set. You are responsible for that licence
and for any Acceptable Use rules attached to the weights.

## Training on model output

`finetune/extract.mjs` builds a dataset from past runs, and each row carries
the model's own words. Some providers forbid using their output to develop
machine learning models at all (xAI's Acceptable Use Policy does), and others
forbid training models that compete with theirs. The extractor leaves xAI
attempts out by default; `--exclude-provider` adds more. Check the terms of
every provider whose runs you intend to train on.

## Benchmarking other agents

This repository benchmarks Maat and openly licensed reference agents only.
Several commercial coding agents forbid benchmarking them, analysing them
competitively, or publishing performance figures about them, so no adapter
or result for such a product is kept here.

## Questions

If a provider’s terms and this note ever conflict, the provider’s terms win.
