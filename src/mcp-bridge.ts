/**
 * A stdio MCP server that is really molt's loopback one, one pipe away.
 *
 * Grok advertises `mcpCapabilities: { http: true }` and takes molt's tool
 * server by URL. Gemini CLI advertises no MCP capabilities at all and has a
 * standing bug against SSE servers passed to `session/new`, so an HTTP entry
 * there is an entry that is quietly ignored — which does not fail, it just
 * produces an agent with no tools, wondering why it cannot write anything.
 *
 * stdio is the transport every MCP client supports, so this exists to speak it:
 * molt spawns one of these per session, the agent talks to it over a pipe, and
 * it forwards each call to the same in-process server, with the same bearer
 * token, that Grok reaches directly. One tool table, one handler, two
 * transports — rather than a second copy of molt's tools to keep in step,
 * which is the bug this repo has now shipped six times.
 *
 * Deliberately tiny and dependency-free: it is spawned as a bare Node script
 * (Electron with `ELECTRON_RUN_AS_NODE`), so anything it imported would have
 * to be resolvable from the packaged app's own layout.
 */
const url = process.env.MOLT_MCP_URL;
const token = process.env.MOLT_MCP_TOKEN;

/** Written to stdout as one line, which is the framing MCP stdio uses. */
function emit(msg: unknown): void {
  process.stdout.write(`${JSON.stringify(msg)}\n`);
}

async function main(): Promise<void> {
  if (!url || !token) {
    // Nothing can be done without them, and exiting silently would look to the
    // agent like a server that started and then had no tools.
    process.stderr.write("molt mcp bridge: MOLT_MCP_URL and MOLT_MCP_TOKEN are required\n");
    process.exit(2);
  }
  let buf = "";
  process.stdin.setEncoding("utf8");
  for await (const chunk of process.stdin) {
    buf += chunk;
    for (;;) {
      const i = buf.indexOf("\n");
      if (i < 0) break;
      const line = buf.slice(0, i).trim();
      buf = buf.slice(i + 1);
      if (!line) continue;
      let msg: { id?: unknown };
      try {
        msg = JSON.parse(line) as { id?: unknown };
      } catch {
        continue;
      }
      try {
        const res = await fetch(url, {
          method: "POST",
          headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
          body: line,
        });
        // 202 is molt's answer to a notification: nothing to forward back.
        if (res.status === 202) continue;
        const text = await res.text();
        if (text) process.stdout.write(`${text}\n`);
      } catch (e) {
        /**
         * A failed hop is answered as a failed call, not dropped.
         *
         * An agent waiting forever on a reply looks exactly like a model that
         * has stopped thinking — the same reason `AcpConnection.answer`
         * refuses unknown methods rather than leaving them hanging.
         */
        if (msg.id !== undefined) {
          emit({
            jsonrpc: "2.0",
            id: msg.id,
            error: { code: -32000, message: `molt bridge: ${String(e)}` },
          });
        }
      }
    }
  }
}

void main();
