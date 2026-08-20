import { readFileSync } from "node:fs";
const key = JSON.parse(readFileSync(process.env.HOME + "/.config/molt/auth.json","utf8")).xai;
// One fixed prefix; each round appends a new turn, exactly like an agent loop.
const SYS = "You are a terse assistant. " + Array.from({length:400},(_,i)=>`Rule ${i}: be brief.`).join(" ");
const msgs = [{ role:"system", content: SYS }, { role:"user", content:"start" }];
const filler = (n) => Array.from({length:n},(_,i)=>`observation ${i}: the file contains a definition and some comments`).join("\n");

async function call(label) {
  const r = await fetch("https://api.x.ai/v1/chat/completions", {
    method:"POST", headers:{ "content-type":"application/json", authorization:`Bearer ${key}` },
    body: JSON.stringify({ model:"grok-4.6", max_tokens:8, messages: msgs }) });
  const t = await r.text();
  if (!r.ok) { console.log(`${label}: HTTP ${r.status} ${t.slice(0,140)}`); return; }
  const u = JSON.parse(t).usage;
  const cached = u.prompt_tokens_details?.cached_tokens ?? 0;
  console.log(`${label.padEnd(12)} prompt=${String(u.prompt_tokens).padStart(6)}  cached=${String(cached).padStart(6)}  (${Math.round(100*cached/u.prompt_tokens)}%)`);
  msgs.push({ role:"assistant", content:"ok" });
}
for (let round = 1; round <= 6; round++) {
  await call(`round ${round}`);
  msgs.push({ role:"user", content: filler(round === 1 ? 60 : 200) });
}
