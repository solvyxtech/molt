/**
 * The journal: an append-only, hash-chained record of everything molt did.
 *
 * Receipts prove a completion claim. Exuviae preserve context. Neither
 * answers the simpler question a stranger actually asks: *what did this
 * thing do?* The journal does, and it does it in a form that cannot be
 * quietly edited afterwards.
 *
 * Every entry carries the SHA-256 of the previous entry. Change or remove
 * any line and every later line's hash stops matching, which `molt verify`
 * reports with the exact entry where the chain broke. This is tamper
 * EVIDENCE, not tamper prevention — anyone with write access can rewrite
 * the whole file and re-chain it. It makes silent edits impossible, which
 * is the honest claim and the useful one.
 *
 * Costs nothing in tokens. It is disk only, and never enters the context.
 */
import { createHash, randomUUID } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

export const GENESIS = "0".repeat(64);

export type JournalKind =
  | "session_start"
  | "user_message"
  | "request"
  | "response"
  | "tool_call"
  | "tool_result"
  | "permission"
  | "bar_run"
  | "shed"
  | "elide"
  | "regrow"
  | "receipt"
  | "cancelled"
  | "note"
  | "error"
  | "session_end";

export type JournalEntry = {
  seq: number;
  iso: string;
  kind: JournalKind;
  /** Facts only. Never a summary, never an interpretation. */
  data: Record<string, unknown>;
  prev: string;
  hash: string;
};

function hashEntry(e: Omit<JournalEntry, "hash">): string {
  return createHash("sha256")
    .update(JSON.stringify({ seq: e.seq, iso: e.iso, kind: e.kind, data: e.data, prev: e.prev }))
    .digest("hex");
}

export type VerifyResult = {
  ok: boolean;
  entries: number;
  /** Sequence number of the first entry whose hash does not match. */
  brokenAt?: number;
  reason?: string;
};

export class Journal {
  readonly dir: string;
  readonly path: string;
  readonly sessionId: string;
  private seq = 0;
  private prev = GENESIS;

  constructor(root: string, sessionId = randomUUID().slice(0, 8)) {
    this.dir = join(root, ".molt", "log");
    mkdirSync(this.dir, { recursive: true });
    this.sessionId = sessionId;
    this.path = join(this.dir, `${sessionId}.jsonl`);
  }

  /**
   * Append a fact. Failures are swallowed: a full disk must not take down a
   * session, and the chain will show the gap.
   */
  append(kind: JournalKind, data: Record<string, unknown> = {}): JournalEntry | null {
    const base = {
      seq: this.seq,
      iso: new Date().toISOString(),
      kind,
      data,
      prev: this.prev,
    };
    const entry: JournalEntry = { ...base, hash: hashEntry(base) };
    try {
      appendFileSync(this.path, JSON.stringify(entry) + "\n", "utf8");
    } catch {
      return null;
    }
    this.seq += 1;
    this.prev = entry.hash;
    return entry;
  }

  static read(file: string): JournalEntry[] {
    if (!existsSync(file)) return [];
    return readFileSync(file, "utf8")
      .split("\n")
      .filter((l) => l.trim())
      .flatMap((l) => {
        try {
          return [JSON.parse(l) as JournalEntry];
        } catch {
          return [];
        }
      });
  }

  static sessions(root: string): string[] {
    const dir = join(root, ".molt", "log");
    if (!existsSync(dir)) return [];
    return readdirSync(dir)
      .filter((f) => f.endsWith(".jsonl"))
      .sort();
  }

  /**
   * Recompute the chain. Reports the first entry that does not match, so a
   * tampered log names the tampering rather than merely failing.
   */
  static verify(file: string): VerifyResult {
    const entries = Journal.read(file);
    if (entries.length === 0) return { ok: true, entries: 0 };

    let prev = GENESIS;
    for (const e of entries) {
      if (e.prev !== prev) {
        return {
          ok: false,
          entries: entries.length,
          brokenAt: e.seq,
          reason: `entry ${e.seq} points at ${e.prev.slice(0, 12)} but the previous entry hashes to ${prev.slice(0, 12)} — an entry was altered or removed`,
        };
      }
      const recomputed = hashEntry({
        seq: e.seq,
        iso: e.iso,
        kind: e.kind,
        data: e.data,
        prev: e.prev,
      });
      if (recomputed !== e.hash) {
        return {
          ok: false,
          entries: entries.length,
          brokenAt: e.seq,
          reason: `entry ${e.seq} was modified after it was written`,
        };
      }
      prev = e.hash;
    }
    return { ok: true, entries: entries.length };
  }

  /**
   * Archive filenames this project's logs say were written, across every
   * session. A durable expectation that does not come from the archive
   * itself — and one that is hash-chained, so removing the expectation is
   * detectable too.
   */
  static expectedArchives(root: string): string[] {
    const dir = join(root, ".molt", "log");
    if (!existsSync(dir)) return [];
    const out = new Set<string>();
    for (const file of Journal.sessions(root)) {
      for (const e of Journal.read(join(dir, file))) {
        if (e.kind !== "shed") continue;
        const name = (e.data as { archive?: unknown }).archive;
        if (typeof name === "string" && name.endsWith(".md")) out.add(name);
      }
    }
    return [...out];
  }

  /** A short human summary of what happened, derived only from the log. */
  static summarize(entries: JournalEntry[]): string[] {
    const out: string[] = [];
    for (const e of entries) {
      const d = e.data as Record<string, string | number | boolean>;
      const t = e.iso.slice(11, 19);
      switch (e.kind) {
        case "session_start":
          out.push(`${t}  session ${d.sessionId} · ${d.provider}/${d.model} · bar: ${d.bar}`);
          break;
        case "user_message":
          out.push(`${t}  user: ${String(d.preview ?? "")}`);
          break;
        case "request":
          out.push(`${t}  → request · ${d.messages} msgs · ~${d.estTokens} tok${d.stream ? " · streaming" : ""}`);
          break;
        case "response": {
          // A `~` means molt counted the tokens itself because the provider
          // reported none — the same mark the meter uses on screen.
          const e = d.estimated ? "~" : "";
          const cached = Number(d.cachedTokens ?? 0) > 0 ? ` (${d.cachedTokens} cached)` : "";
          const cost =
            d.costUsd === null || d.costUsd === undefined
              ? ""
              : ` · ${d.billed ? "" : e}$${Number(d.costUsd).toFixed(6)}`;
          out.push(
            `${t}  ← response · ${e}${d.promptTokens} in${cached} / ${e}${d.completionTokens} out · ` +
              `${d.toolCalls} tool call(s)${cost}`,
          );
          break;
        }
        case "tool_call":
          out.push(`${t}  tool ${d.name}: ${d.detail}`);
          break;
        case "tool_result":
          out.push(`${t}    ${d.bytes} bytes${d.truncated ? " (truncated)" : ""}${d.note ? ` [${d.note}]` : ""}`);
          break;
        case "permission":
          out.push(`${t}  permission ${d.allowed ? "granted" : "DENIED"}: ${d.name} ${d.detail}`);
          break;
        case "bar_run":
          out.push(`${t}  bar ${d.ok ? "PASS" : "FAIL"} ${d.passed}/${d.total}${d.failed ? ` · failed: ${d.failed}` : ""} · ${d.ms}ms`);
          break;
        case "shed":
          out.push(`${t}  shed ${d.dropped} msgs · ~${d.before}→~${d.after} tok · ${d.archive}`);
          break;
        case "elide":
          out.push(`${t}  pruned ${d.elided} superseded result(s) · ~−${d.tokensSaved} tok`);
          break;
        case "regrow":
          out.push(`${t}  regrew ${d.attached}/${d.hits} match(es) · ~+${d.tokens} tok`);
          break;
        case "receipt":
          out.push(`${t}  receipt ${d.verdict} → ${d.file}`);
          break;
        case "cancelled":
          out.push(`${t}  cancelled · turn rolled back`);
          break;
        case "note":
          out.push(`${t}  note: ${d.text}`);
          break;
        case "error":
          out.push(`${t}  error: ${d.text}`);
          break;
        case "session_end":
          out.push(`${t}  session end · ${d.reason}`);
          break;
      }
    }
    return out;
  }
}
