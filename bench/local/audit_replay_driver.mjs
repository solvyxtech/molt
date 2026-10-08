// One post-work audit (src/post-audit.ts) on a saved tree, for audit_replay.py.
// stdin: {"task", "workDir", "preWorkDir", "judge": {"baseUrl", "apiKey", "model"}, "reasoningEffort"?}
// stdout: the AuditReport as one JSON line.
const dist = process.env.MOLT_DIST_ABS;
if (!dist) {
  console.error("MOLT_DIST_ABS is not set");
  process.exit(2);
}
const { postWorkAudit } = await import(`${dist}/post-audit.js`);
let raw = "";
for await (const chunk of process.stdin) raw += chunk;
const input = JSON.parse(raw);
const report = await postWorkAudit({
  task: input.task,
  workDir: input.workDir,
  preWorkDir: input.preWorkDir,
  judge: input.judge,
  ...(input.reasoningEffort ? { reasoningEffort: input.reasoningEffort } : {}),
  deadlineAt: Date.now() + 240_000,
});
process.stdout.write(`${JSON.stringify(report)}\n`);
