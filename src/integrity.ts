/**
 * The integrity ledger: binds every piece of evidence in a project into one
 * hash-chained record, and exposes a root of trust that can be shipped
 * somewhere molt cannot write.
 *
 * The journal, the receipts, and the exuviae are each self-consistent on
 * their own — each hashes its own contents. But before this existed nothing
 * tied them to one another: verify the journal, and you have not checked
 * that its "receipt written here" line points at the receipt that is on
 * disk, nor that the receipt's claim matches the journal that produced it.
 * Each island was provable but the archipelago was not.
 *
 * This ledger is the archipelago. Every materially interesting event —
 * session start, a shed, a receipt, session end — appends a chained record
 * carrying the *other* artifacts' hashes as of that instant:
 *
 *   - the journal's chain root (its head hash),
 *   - the receipt file's sha256,
 *   - the exuvia file's sha256.
 *
 * The record's own chain is the project-level chain. Its head is the
 * project's root of trust. Tamper with a journal, a receipt, or an exuvia
 * after it was bound here and the binding no longer matches — the chain
 * still verifies, but the bound hash disagrees with the file on disk, and
 * `Integrity.verify` says exactly which artifact drifted and where.
 *
 * Like the journal, this is tamper EVIDENCE, not tamper prevention: anyone
 * with write access can rewrite the ledger and re-chain it. What it rules
 * out is a silent, partial edit — and, combined with a root of trust kept
 * somewhere molt cannot write, it forces any later rewrite to be caught.
 */
import { createHash } from "node:crypto";
import {
  appendFileSync,
  existsSync,
  readFileSync,
  readdirSync,
  mkdirSync,
} from "node:fs";
import { join } from "node:path";
import { redactData } from "./redact.js";
import { GENESIS, Journal, type VerifyResult } from "./journal.js";

export const INTEGRITY_GENESIS = "0".repeat(64);

export type IntegrityEvent =
  /** A session began. Binds the journal root at its first record. */
  | { kind: "session_start"; session: string; journalRoot: string }
  /** Context was shed to the archive. Binds the exuvia and journal root. */
  | { kind: "shed"; session: string; exuvia: string; exuviaSha: string; journalRoot: string }
  /** A receipt was written. Binds the receipt file and journal root. */
  | {
      kind: "receipt";
      session: string;
      receiptFile: string;
      receiptSha: string;
      journalRoot: string;
      verdict: string;
    };

/** A chained record in the integrity ledger. */
export type IntegrityRecord = {
  seq: number;
  iso: string;
  kind: IntegrityEvent["kind"];
  data: Record<string, unknown>;
  prev: string;
  hash: string;
};

export type IntegrityVerify = {
  ok: boolean;
  /**
   * Whether there is a chain at all.
   *
   * A ledger with no records is not a verified project, it is an unverified
   * one, and the two must never print the same word. `ok` on an empty ledger
   * means only "no contradiction found" — which is what a check that read
   * nothing is always entitled to say, and why it must not be read as a pass.
   */
  established: boolean;
  records: number;
  /** The first record whose chain links do not match, if any. */
  brokenAt?: number;
  reason?: string;
  /** Every bound artifact that exists on disk but disagrees with its bound hash. */
  drift: { kind: string; file: string; bound: string }[];
  /**
   * Evidence on disk that no record binds — receipts and exuviae written
   * before the ledger existed, or by a surface that never wired one in.
   * Not a failure, and not covered either: the reach of the check, stated
   * rather than implied.
   */
  unbound: { kind: string; file: string }[];
};

/**
 * Calculate the sha256 of a file. Returns "" if it cannot be read — an
 * artifact that vanished after being bound is a drift the verifier names,
 * not a value it fabricates.
 */
export function sha256FileSync(file: string): string {
  try {
    return createHash("sha256").update(readFileSync(file, "utf8")).digest("hex");
  } catch {
    return "";
  }
}

export class Integrity {
  readonly dir: string;
  readonly path: string;
  private prev = INTEGRITY_GENESIS;
  private seq = 0;
  private secrets: (string | undefined)[] = [];

  constructor(root: string) {
    this.dir = join(root, ".molt", "integrity");
    mkdirSync(this.dir, { recursive: true });
    this.path = join(this.dir, "ledger.jsonl");
    if (existsSync(this.path)) {
      for (const r of Integrity.read(this.path)) {
        this.seq = Math.max(this.seq, r.seq + 1);
        this.prev = r.hash;
      }
    }
  }

  /** Register a value to mask. Same contract as Journal.protect. */
  protect(...values: (string | undefined)[]): void {
    for (const v of values) {
      if (v && !this.secrets.includes(v)) this.secrets.push(v);
    }
  }

  /**
   * Append a fact to the chain. A write failure is swallowed: the evidence
   * chain must never be allowed to break a running session, and the failed
   * write is itself visible as a gap next time the ledger is read.
   */
  append(event: IntegrityEvent): IntegrityRecord | null {
    const base = {
      seq: this.seq,
      iso: new Date().toISOString(),
      kind: event.kind,
      data: redactData({ ...event } as unknown as Record<string, unknown>, this.secrets),
      prev: this.prev,
    };
    const record: IntegrityRecord = { ...base, hash: this.hashOf(base) };
    try {
      appendFileSync(this.path, JSON.stringify(record) + "\n", "utf8");
    } catch {
      return null;
    }
    this.seq += 1;
    this.prev = record.hash;
    return record;
  }

  chainRoot(): string {
    return this.prev;
  }

  private hashOf(
    base: Omit<IntegrityRecord, "hash">,
  ): string {
    return createHash("sha256")
      .update(
        JSON.stringify({ seq: base.seq, iso: base.iso, kind: base.kind, data: base.data, prev: base.prev }),
      )
      .digest("hex");
  }

  static read(file: string): IntegrityRecord[] {
    if (!existsSync(file)) return [];
    return readFileSync(file, "utf8")
      .split("\n")
      .filter((l) => l.trim())
      .flatMap((l) => {
        try {
          return [JSON.parse(l) as IntegrityRecord];
        } catch {
          return [];
        }
      });
  }

  /**
   * Verify the whole cross-linked chain for a project.
   *
   * Two independent checks:
   *
   *  1. Chain integrity: each record hashes its predecessor, so an entry
   *     altered, deleted, or inserted breaks the chain from that point on.
   *  2. Artefact binding: for every bound artifact (a receipt file, an
   *     exuvia), what is on disk must hash to what the ledger said it was at
   *     the moment it was recorded. A receipt edited after the fact drifts
   *     here even though the ledger chain still verifies.
   *
   * Drift is reported separately from a broken chain, because they are
   * different failures with different meanings: a broken chain is a record
   * that was edited; drift is an artifact that changed after it was sealed.
   */
  static verify(root: string): IntegrityVerify {
    const path = join(root, ".molt", "integrity", "ledger.jsonl");
    const records = Integrity.read(path);
    const out: IntegrityVerify = {
      ok: true,
      established: records.length > 0,
      records: records.length,
      drift: [],
      unbound: unboundArtifacts(root, records),
    };
    if (records.length === 0) return out;

    let prev = INTEGRITY_GENESIS;
    const hashOf = (base: Omit<IntegrityRecord, "hash">): string =>
      createHash("sha256")
        .update(JSON.stringify({ seq: base.seq, iso: base.iso, kind: base.kind, data: base.data, prev: base.prev }))
        .digest("hex");
    for (const r of records) {
      if (r.prev !== prev) {
        out.ok = false;
        out.brokenAt = r.seq;
        out.reason = `record ${r.seq} points at ${r.prev.slice(0, 12)} but the previous record hashes to ${prev.slice(0, 12)} — an entry was altered or removed`;
        return out;
      }
      const recomputed = hashOf({
        seq: r.seq,
        iso: r.iso,
        kind: r.kind,
        data: r.data,
        prev: r.prev,
      });
      if (recomputed !== r.hash) {
        out.ok = false;
        out.brokenAt = r.seq;
        out.reason = `record ${r.seq} was modified after it was written`;
        return out;
      }
      prev = r.hash;
    }

    // Binding check: every artifact the ledger names must still be exactly
    // what the ledger said it was at the moment of binding.
    for (const r of records) {
      const d = r.data;
      if (r.kind === "receipt") {
        const file = String(d.receiptFile ?? "");
        const bound = String(d.receiptSha ?? "");
        if (!file) continue;
        if (!bound) {
          // A record that names an artifact but carries no hash for it binds
          // nothing. Skipping it — the obvious reading of "no hash to compare"
          // — is how a receipt bound with an empty sha verified clean for
          // every real session: the ledger looked full and proved nothing.
          out.drift.push({ kind: "receipt", file, bound: "(never hashed)" });
          continue;
        }
        const actual = sha256FileSync(join(root, ".molt", "receipts", file));
        if (actual && actual !== bound) {
          out.drift.push({ kind: "receipt", file, bound: bound.slice(0, 12) });
        } else if (!actual) {
          out.drift.push({ kind: "receipt", file, bound: "(missing)" });
        }
      } else if (r.kind === "shed") {
        const file = String(d.exuvia ?? "");
        const bound = String(d.exuviaSha ?? "");
        if (!file) continue;
        if (!bound) {
          out.drift.push({ kind: "exuvia", file, bound: "(never hashed)" });
          continue;
        }
        const actual = sha256FileSync(join(root, ".molt", "exuviae", file));
        if (actual && actual !== bound) {
          out.drift.push({ kind: "exuvia", file, bound: bound.slice(0, 12) });
        } else if (!actual) {
          out.drift.push({ kind: "exuvia", file, bound: "(missing)" });
        }
      }
    }

    // Journal binding. Every record carries the journal's chain root at the
    // moment it was written, and nothing read it back: a journal rewritten and
    // re-chained — one bar verdict flipped, every later hash recomputed — kept
    // its own chain intact, kept this chain intact, and printed the same root
    // of trust as before. Five of the six roots this ledger held for one real
    // session no longer named any entry in the journal, and "ok" was printed
    // over all of them. The root is a hash of an entry; the entry has to be
    // there. Genesis binds nothing and is not checked, for the same reason an
    // empty ledger prints no root of trust.
    const journals = new Map<string, Set<string>>();
    for (const r of records) {
      const session = String(r.data.session ?? "");
      const bound = String(r.data.journalRoot ?? "");
      if (!session || !bound || bound === GENESIS) continue;
      const file = `${session}.jsonl`;
      let heads = journals.get(file);
      if (!heads) {
        const path = join(root, ".molt", "log", file);
        heads = existsSync(path) ? new Set(Journal.read(path).map((e) => e.hash)) : new Set();
        journals.set(file, heads);
      }
      if (!existsSync(join(root, ".molt", "log", file))) {
        out.drift.push({ kind: "journal", file, bound: "(missing)" });
      } else if (!heads.has(bound)) {
        out.drift.push({ kind: "journal", file, bound: bound.slice(0, 12) });
      }
    }

    out.ok = out.drift.length === 0;
    return out;
  }

  /**
   * Everything `molt verify` checks, as one verdict — for a surface that has
   * one button rather than one printout.
   *
   * The desktop's "verify evidence chain" ran `verify()` alone and answered
   * "intact" over a journal whose chain the terminal reported as broken at
   * entry 16. Two surfaces, two definitions of verified. This is the one
   * definition: every session log recomputes, and the ledger links and binds.
   */
  static verifyProject(root: string): {
    ok: boolean;
    ledger: IntegrityVerify;
    /** One row per session log, in the order `Journal.sessions` lists them. */
    journals: ({ file: string } & VerifyResult)[];
    root: string | null;
  } {
    const journals = Journal.sessions(root).map((file) => ({
      file,
      ...Journal.verify(join(root, ".molt", "log", file)),
    }));
    const ledger = Integrity.verify(root);
    return {
      ok: ledger.ok && journals.every((j) => j.ok),
      ledger,
      journals,
      root: Integrity.exportRoot(root).root,
    };
  }

  /**
   * The project's root of trust: the head of the integrity chain, plus the
   * metadata needed to check it elsewhere. This is the value to ship to a
   * place molt cannot write — a git repo, a gist, a separate machine.
   *
   * Null until the first record. The genesis constant is the same 64 zeroes
   * in every project on earth: shipping it as a root of trust would ship a
   * number that proves nothing, that matches before and after any rewrite,
   * and that looks exactly like a real one to whoever files it away.
   */
  static exportRoot(root: string): { root: string | null; records: number; generatedAt: string } {
    const path = join(root, ".molt", "integrity", "ledger.jsonl");
    const records = Integrity.read(path);
    return {
      root: records.length ? records[records.length - 1]!.hash : null,
      records: records.length,
      generatedAt: new Date().toISOString(),
    };
  }
}

/**
 * Evidence sitting on disk that no record in the ledger binds.
 *
 * A ledger only ever proves what it names, and it names nothing written
 * before it existed — which, the day this shipped, was every receipt and
 * every exuvia in every project. Those files are not tampered with; they are
 * simply not covered. Reporting the chain as "intact" beside 42 unbound
 * receipts would let "intact" be read as "all of this is verified", so the
 * uncovered files are counted and named instead.
 */
function unboundArtifacts(
  root: string,
  records: IntegrityRecord[],
): { kind: string; file: string }[] {
  const bound = new Set<string>();
  for (const r of records) {
    if (r.kind === "receipt" && r.data.receiptFile) {
      bound.add(`receipt:${String(r.data.receiptFile)}`);
    } else if (r.kind === "shed" && r.data.exuvia) {
      bound.add(`exuvia:${String(r.data.exuvia)}`);
    }
  }
  const out: { kind: string; file: string }[] = [];
  for (const [kind, dir] of [
    ["receipt", "receipts"],
    ["exuvia", "exuviae"],
  ] as const) {
    let files: string[] = [];
    try {
      files = readdirSync(join(root, ".molt", dir)).filter(
        // `.molt/exuviae/index.md` is the archive's own browsable index, not
        // a shed batch — nothing binds it and nothing should report it.
        (f) => f.endsWith(".md") && f !== "index.md",
      );
    } catch {
      // No directory is no evidence, which is nothing to report.
      continue;
    }
    for (const file of files.sort()) {
      if (!bound.has(`${kind}:${file}`)) out.push({ kind, file });
    }
  }
  return out;
}
