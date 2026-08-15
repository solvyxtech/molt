/**
 * Shed R&D lab: quantify what /shed actually does over long sessions.
 *  - Simulates 120-turn sessions with seeded "facts"
 *  - Runs repeated shed cycles as the session grows
 *  - Audits: is every fact recoverable from (live context ∪ exuviae)?
 *  - Times bom()/shed() on large histories
 */
import { Engine, estTokens } from "../src/engine.js";

const facts: string[] = [];
const exuviae: string[] = [];

function fakeFetch(turn: () => string): typeof fetch {
  return (async () =>
    new Response(
      JSON.stringify({
        choices: [{ message: { role: "assistant", content: turn() } }],
        usage: { prompt_tokens: 300, completion_tokens: 120 },
      }),
      { status: 200 },
    )) as typeof fetch;
}

let t = 0;
const engine = new Engine({
  baseUrl: "http://lab/v1",
  model: "lab",
  fetchFn: fakeFetch(() => {
    const fact = `FACT_${t}_${Math.random().toString(36).slice(2, 8)}`;
    facts.push(fact);
    return `Result for step ${t}: applied change ${fact}. ` + "filler detail ".repeat(30);
  }),
});

const allow = async () => true;
const rows: string[] = [];
let sheds = 0;

for (t = 1; t <= 120; t++) {
  for await (const _ of engine.run(
    `step ${t}: please handle FACT_REQ_${t} ` + "context noise ".repeat(10),
    allow,
  )) { /* drain */ }

  const hist = engine.bom().historyTokens;
  if (hist > 8000) {
    const t0 = performance.now();
    const r = engine.shed(2);
    const ms = (performance.now() - t0).toFixed(1);
    if (r) {
      sheds++;
      exuviae.push(r.exuvia);
      rows.push(
        `shed#${sheds} @turn ${t}: ${r.beforeTokens} → ${r.afterTokens} tok ` +
        `(-${(100 * (1 - r.afterTokens / r.beforeTokens)).toFixed(1)}%) · ` +
        `${r.droppedCount} msgs · exuvia ${(r.exuvia.length / 1024).toFixed(1)}KB · ${ms}ms`,
      );
    }
  }
}

console.log("=== shed cycles ===");
rows.forEach((r) => console.log(r));

// Fact-preservation audit: every fact must live in context OR an exuvia.
const live = JSON.stringify((engine as unknown as { messages: unknown }).messages ?? "");
const liveText = live + " " + (engine.lastRequestBody ?? "");
const shedText = exuviae.join(" ");
let inLive = 0, inShed = 0, lost = 0;
const lostList: string[] = [];
for (const f of facts) {
  if (liveText.includes(f)) inLive++;
  else if (shedText.includes(f)) inShed++;
  else { lost++; lostList.push(f); }
}
console.log("\n=== fact preservation audit ===");
console.log(`facts seeded: ${facts.length} · in live context: ${inLive} · in exuviae: ${inShed} · LOST: ${lost}`);
if (lost) console.log("lost:", lostList.slice(0, 5));

console.log("\n=== final state ===");
const b = engine.bom();
console.log(`history ${b.historyTokens} tok · session real ${b.sessionPromptTokens} in / ${b.sessionCompletionTokens} out`);

// Perf: bom() and shed() on a huge synthetic history
const big = new Engine({ baseUrl: "http://lab/v1", model: "lab", fetchFn: fakeFetch(() => "x ".repeat(400)) });
for (t = 0; t < 500; t++) {
  for await (const _ of big.run("perf turn " + "y ".repeat(50), allow)) { /* drain */ }
}
let t0 = performance.now();
for (let i = 0; i < 100; i++) big.bom();
console.log(`\n=== perf (1000+ msg history) ===`);
console.log(`bom(): ${((performance.now() - t0) / 100).toFixed(2)}ms avg`);
t0 = performance.now();
big.shed(2);
console.log(`shed(): ${(performance.now() - t0).toFixed(1)}ms once`);
console.log(`digest size sanity: est system prompt ${estTokens("x")}-ish check ok`);
