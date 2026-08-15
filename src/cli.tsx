#!/usr/bin/env node
import React from "react";
import { render } from "ink";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { App } from "./app.js";
import { Engine, SYSTEM_PROMPT, estTokens } from "./engine.js";
import {
  THEMES,
  DEFAULT_THEME,
  resolveCustomTheme,
  type Theme,
} from "./theme.js";

const VERSION = "0.5.0";

function arg(flag: string): string | undefined {
  const i = process.argv.indexOf(flag);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

if (process.argv.includes("--help") || process.argv.includes("-h")) {
  console.log(`molt ${VERSION} — same engine · shed the stock shell

usage: molt [--base-url URL] [--model NAME] [--budget TOKENS]
            [--price-in $/Mtok] [--price-out $/Mtok]

env:   MOLT_BASE_URL  MOLT_API_KEY  MOLT_MODEL  MOLT_PRICE_IN  MOLT_PRICE_OUT
       (also honors OPENAI_BASE_URL / OPENAI_API_KEY / OPENROUTER_API_KEY)

in-session: /connect /login /model /doctor /bom /wire /shed /regrow
            /budget /race /molt /new /help
setup:      molt → /login (pick provider, paste key) → /model (pick) → go
keys:       stored per-host in ~/.config/molt/auth.json (chmod 600)`);
  process.exit(0);
}
if (process.argv.includes("--version") || process.argv.includes("-v")) {
  console.log(VERSION);
  process.exit(0);
}

/**
 * Any OpenAI-compatible endpoint works: local llama.cpp / Ollama / vLLM,
 * OpenRouter, OpenAI, Groq. No vendor lock, no OAuth, no subscription-token
 * ToS problems — your key (or no key, for local).
 */
const configDir = join(homedir(), ".config", "molt");
function readJson(file: string): Record<string, string> {
  try {
    return JSON.parse(readFileSync(join(configDir, file), "utf8"));
  } catch {
    return {};
  }
}
const saved = readJson("config.json");
const savedAuth = readJson("auth.json");

const baseUrl =
  arg("--base-url") ??
  process.env.MOLT_BASE_URL ??
  process.env.OPENAI_BASE_URL ??
  saved.baseUrl ??
  "http://localhost:11434/v1"; // Ollama default — local-first
let host = "";
try { host = new URL(baseUrl).host; } catch { /* fall through */ }
const apiKey =
  process.env.MOLT_API_KEY ??
  process.env.OPENROUTER_API_KEY ??
  process.env.OPENAI_API_KEY ??
  savedAuth[host];
const model =
  arg("--model") ?? process.env.MOLT_MODEL ?? saved.model ?? "qwen2.5-coder:14b";
const num = (v?: string) => (v !== undefined && v !== "" ? Number(v) : undefined);
const priceIn = num(arg("--price-in") ?? process.env.MOLT_PRICE_IN);
const priceOut = num(arg("--price-out") ?? process.env.MOLT_PRICE_OUT);
const budget = num(arg("--budget"));

const engine = new Engine({
  baseUrl,
  apiKey,
  model,
  priceInPerMtok: Number.isFinite(priceIn) ? priceIn : undefined,
  priceOutPerMtok: Number.isFinite(priceOut) ? priceOut : undefined,
});
if (Number.isFinite(budget) && budget! > 0) engine.setBudget(budget);

function loadCustomTheme(): Theme | undefined {
  try {
    const p = join(homedir(), ".config", "molt", "theme.json");
    const raw = JSON.parse(readFileSync(p, "utf8"));
    return resolveCustomTheme(raw, THEMES[DEFAULT_THEME]);
  } catch {
    return undefined;
  }
}

render(
  <App
    engine={engine}
    animateBanner
    customTheme={loadCustomTheme()}
    initialNotice={`${model} @ ${baseUrl} · system prompt: ${estTokens(SYSTEM_PROMPT)} tok (est) · /doctor to preflight · /bom for the bill`}
  />,
);
