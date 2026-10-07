// Runs INSIDE the container: reads jobs.json [{id,system,prompt}], writes one line per ask to out.jsonl.
// Uses the installed Maat's askModel (the same call the criteria drafter makes), no tools.
import { readFileSync, appendFileSync } from "node:fs";
import { execSync } from "node:child_process";
const root = execSync("npm root -g").toString().trim();
const { askModel } = await import(`${root}/@solvyx/molt/dist/ask.js`);
const [jobsFile, outFile] = process.argv.slice(2);
const jobs = JSON.parse(readFileSync(jobsFile, "utf8"));
const conc = Number(process.env.PROBE_CONC || 3);
let i = 0;
async function worker() {
  while (i < jobs.length) {
    const j = jobs[i++];
    const t0 = Date.now();
    const r = await askModel({ baseUrl: "grok-build://subscription", model: "grok-4.7", system: j.system, prompt: j.prompt, maxTokens: 6000, reasoningEffort: process.env.PROBE_EFFORT || "low", cwd: "/tmp/empty", what: "probing ambiguity", timeoutMs: Number(process.env.PROBE_TIMEOUT_MS || 240000) });
    appendFileSync(outFile, JSON.stringify({ id: j.id, secs: Math.round((Date.now() - t0) / 1000), ...r }) + "\n");
  }
}
await Promise.all(Array.from({ length: conc }, worker));
