/**
 * The archive: where shed context is kept.
 *
 * Separated from Transcript so the transcript stays pure and the write can
 * be made to fail on purpose in tests. That matters more than it sounds:
 * "nothing is ever lost" is only true if a failed disk write cannot take
 * context with it, and the only way to know is to break the disk on demand.
 *
 * Layout:
 *   .molt/exuviae/0000-<iso>.md   full unabridged shed batches
 *   .molt/exuviae/index.md        one line each, so the archive is browsable
 */
import { createHash } from "node:crypto";
import type { LedgerEntry } from "./types.js";
import { mkdirSync, readFileSync, readdirSync, writeFileSync, appendFileSync, existsSync } from "node:fs";
import { join } from "node:path";

export type ArchiveEntry = {
  index: number;
  file: string;
  iso: string;
  messages: number;
  bytes: number;
  sha256: string;
  firstAsk: string;
};

export interface ArchiveLike {
  write(exuvia: string, messages: number, firstAsk: string, ledger?: LedgerEntry[]): ArchiveEntry;
  list(): ArchiveEntry[];
  read(index: number): string;
  grep?(pattern: string): { index: number; excerpt: string }[];
  /**
   * Write evidence recovered from archived batches.
   *
   * `only` selects exuvia indices — in practice the ones the running session
   * shed. Omitting it reads every batch in the directory, which is the right
   * answer for browsing history and the wrong one for judging a turn.
   */
  ledger?(only?: ReadonlySet<number>): LedgerEntry[];
  /**
   * Exuviae whose write-evidence block is present but cannot be parsed.
   *
   * `ledger()` skips such a block, which is the right answer for a reader
   * and the wrong one for a check: in a later session the count it is
   * compared against is zero, so a corrupted block was "absent evidence"
   * that nothing ever reported. Named here so record-intact can.
   */
  damaged?(only?: ReadonlySet<number>): string[];
  dir: string;
}

/**
 * Marker for the write-evidence block embedded in an exuvia.
 *
 * This is what makes the archive load-bearing rather than decorative. When
 * context is shed, the record of which files were written during it goes
 * with it — so a later completion check has to read the archive to know
 * whether early work actually landed. Delete an exuvia and the evidence for
 * that work is genuinely gone, which is exactly the property that lets molt
 * claim verification runs against preserved history.
 */
export const LEDGER_MARKER = "molt-ledger";

export class Archive implements ArchiveLike {
  readonly dir: string;
  private indexPath: string;
  private seq = 0;

  constructor(root: string) {
    this.dir = join(root, ".molt", "exuviae");
    this.indexPath = join(this.dir, "index.md");
    mkdirSync(this.dir, { recursive: true });
    // Not `.length`: an exuvia deleted out of the middle (the exact tamper
    // record-intact exists to catch) makes the count fall below the highest
    // index already on disk. Seeding the next write from the count then
    // reissues that index — two files answer to the same number, and
    // `read()`/`grep()` resolve to whichever sorts first, making the *new*
    // batch's content unreachable even though nothing about it was tampered
    // with. The next index has to be one past the highest that ever existed.
    this.seq = this.list().reduce((max, e) => Math.max(max, e.index + 1), 0);
    if (!existsSync(this.indexPath)) {
      writeFileSync(
        this.indexPath,
        "# molt exuviae index\n\nEvery batch of context shed in this project. Nothing here was summarized.\n\n" +
          "| # | when | msgs | bytes | sha256 | first ask |\n|---|---|---|---|---|---|\n",
        "utf8",
      );
    }
  }

  write(exuvia: string, messages: number, firstAsk: string, ledger: LedgerEntry[] = []): ArchiveEntry {
    if (ledger.length > 0) {
      exuvia +=
        `\n\n## write evidence\n\n` +
        `Files molt wrote during the messages above, with the hash before the\n` +
        `write and the hash molt observed after it. Completion checks read this.\n\n` +
        "```" + LEDGER_MARKER + "\n" +
        JSON.stringify(ledger, null, 2) +
        "\n```\n";
    }
    const index = this.seq;
    const iso = new Date().toISOString();
    const file = `${String(index).padStart(4, "0")}-${iso.replace(/[:.]/g, "-")}.md`;
    const bytes = Buffer.byteLength(exuvia, "utf8");
    const sha256 = createHash("sha256").update(exuvia, "utf8").digest("hex");

    // Write the batch first, then the index. If the batch write throws, the
    // caller never commits the shed and the index never claims a file that
    // is not there.
    writeFileSync(join(this.dir, file), exuvia, "utf8");
    const ask = firstAsk.replace(/\s+/g, " ").slice(0, 60);
    appendFileSync(
      this.indexPath,
      `| ${index} | ${iso} | ${messages} | ${bytes} | ${sha256.slice(0, 12)} | ${escapePipes(ask)} |\n`,
      "utf8",
    );

    this.seq += 1;
    return { index, file, iso, messages, bytes, sha256, firstAsk: ask };
  }

  list(): ArchiveEntry[] {
    if (!existsSync(this.dir)) return [];
    const files = readdirSync(this.dir)
      .filter((f) => /^\d{4}-.*\.md$/.test(f))
      .sort();
    return files.map((file) => {
      const body = readFileSync(join(this.dir, file), "utf8");
      const index = Number(file.slice(0, 4));
      const messages = (body.match(/^## /gm) ?? []).length;
      return {
        index,
        file,
        iso: "",
        messages,
        bytes: Buffer.byteLength(body, "utf8"),
        sha256: createHash("sha256").update(body, "utf8").digest("hex"),
        firstAsk: "",
      };
    });
  }

  /**
   * Every write recorded in every archived batch, oldest first. Spans
   * sessions: a batch shed yesterday still yields its evidence today.
   */
  /**
   * Write evidence from archived batches, optionally only the given indices.
   *
   * The directory outlives the session. Reading all of it made every turn be
   * judged against the accumulated writes of every session that ever shed
   * context here — a real receipt shows a turn whose only work was
   * `src/files.ts` having its lines mutated in `electron/main.ts` and
   * `ui/index.html`, written days earlier by someone else. Worse, `files-changed`
   * then reports "contents changed since molt wrote it" for any of those a
   * later commit touched, and the only way a model can clear that is to
   * rewrite a file it has no reason to touch. One did exactly that: six
   * comment-only word swaps in one step, and the bar accepted the turn.
   *
   * A check that can be satisfied by editing something irrelevant is not a
   * check. So callers judging a turn pass the batches that turn shed.
   */
  ledger(only?: ReadonlySet<number>): LedgerEntry[] {
    const out: LedgerEntry[] = [];
    for (const entry of this.list()) {
      if (only && !only.has(entry.index)) continue;
      const body = readFileSync(join(this.dir, entry.file), "utf8");
      const re = new RegExp("```" + LEDGER_MARKER + "\\n([\\s\\S]*?)\\n```", "g");
      let m: RegExpExecArray | null;
      while ((m = re.exec(body)) !== null) {
        try {
          const parsed = JSON.parse(m[1]) as LedgerEntry[];
          if (Array.isArray(parsed)) out.push(...parsed);
        } catch {
          // A corrupted block is a missing block. record-intact reports it.
        }
      }
    }
    return out;
  }

  damaged(only?: ReadonlySet<number>): string[] {
    const out: string[] = [];
    for (const entry of this.list()) {
      if (only && !only.has(entry.index)) continue;
      const body = readFileSync(join(this.dir, entry.file), "utf8");
      const re = new RegExp("```" + LEDGER_MARKER + "\\n([\\s\\S]*?)\\n```", "g");
      let m: RegExpExecArray | null;
      while ((m = re.exec(body)) !== null) {
        try {
          if (!Array.isArray(JSON.parse(m[1]))) throw new Error("not a list");
        } catch {
          out.push(entry.file);
          break;
        }
      }
    }
    return out;
  }

  read(index: number): string {
    const entry = this.list().find((e) => e.index === index);
    if (!entry) throw new Error(`no exuvia ${index} in ${this.dir}`);
    return readFileSync(join(this.dir, entry.file), "utf8");
  }

  /** Search archived batches, returning matching sections with their index. */
  grep(pattern: string): { index: number; excerpt: string }[] {
    const re = new RegExp(pattern, "i");
    const hits: { index: number; excerpt: string }[] = [];
    for (const entry of this.list()) {
      const body = this.read(entry.index);
      const sections = body.split(/^## /m).slice(1);
      for (const s of sections) {
        if (re.test(s)) hits.push({ index: entry.index, excerpt: "## " + s.trim() });
      }
    }
    return hits;
  }
}

function escapePipes(s: string): string {
  return s.replace(/\|/g, "\\|");
}
