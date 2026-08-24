// Boots the real app under a virtual display and reports what the window did.
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const electron = require("electron");

const p = spawn(electron, ["out/main.cjs", "--enable-logging"], {
  env: { ...process.env, MOLT_SMOKE: "1" },
  stdio: ["ignore", "pipe", "pipe"],
});
let out = "";
p.stdout.on("data", (d) => (out += d));
p.stderr.on("data", (d) => (out += d));
setTimeout(() => {
  p.kill("SIGTERM");
  console.log(out.trim() || "(no output)");
  process.exit(0);
}, 6000);
