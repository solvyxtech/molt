// Replay driver for the shipped TypeScript lint (src/checklint.ts, built to dist/).
// stdin: JSON [{task, cmd, pristine, text}]; argv[2]: "sh" | "bash"; stdout: JSON [[rule:detail, ...], ...]
// Probes emulate the bench image (Debian bookworm: dash, mawk 1.3.4-2020, no pytest, no `python`).
import { readFileSync } from "node:fs";
import { lintAll, readTree } from "../../dist/checklint.js";

const IMAGE = new Set(("python3 git sqlite3 jq make curl node npm npx sh bash awk sed grep find xargs sort uniq wc head tail cut tr cat diff cmp test ls cp mv rm mkdir touch tee echo printf true false seq date stat chmod basename dirname env sleep kill pkill timeout tac rev od xxd file md5sum sha256sum ps pgrep nproc perl").split(" "));
const probes = {
  hasCommand: (n) => IMAGE.has(n),
  hasPyModule: () => false,
  awkIntervals: () => false,
};
const shell = process.argv[2] === "bash" ? "bash" : "sh";
const items = JSON.parse(readFileSync(0, "utf8"));
const trees = new Map();
const out = items.map((it) => {
  if (!trees.has(it.pristine)) trees.set(it.pristine, readTree(it.pristine));
  return lintAll(it.cmd, { cwd: it.pristine, tree: trees.get(it.pristine), task: it.text, shell, probes }).map((h) => `${h.rule.includes(":") ? h.rule : h.rule}`);
});
process.stdout.write(JSON.stringify(out));
