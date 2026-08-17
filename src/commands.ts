/**
 * The command palette.
 *
 * Kept pure and free of Ink so the matching rules are testable — a palette
 * that surfaces the wrong command is worse than no palette, because it
 * teaches people to stop reading it.
 *
 * Rules, in priority order:
 *   1. exact name
 *   2. prefix of the name           (/re → /receipts, /regrow)
 *   3. subsequence of the name      (/rgw → /regrow)
 *   4. word match in the summary    (/token → /budget, /bom)
 *
 * Ties break toward the shorter name, then alphabetically, so the ordering
 * is stable between keystrokes. A list that reorders under your fingers is
 * how you pick the wrong thing.
 */

export type Command = {
  name: string;
  /** Argument hint shown after the name, e.g. "<pattern>". */
  args?: string;
  summary: string;
  /** Extra terms that should match this command. */
  aliases?: string[];
};

export const COMMANDS: Command[] = [
  { name: "/help", summary: "list every command" },
  { name: "/prove", summary: "run the bar now, without the model" },
  { name: "/bar", summary: "show the checks this project requires" },
  { name: "/init", summary: "write a starter .molt/done.yml" },
  { name: "/receipts", summary: "completion attempts and their verdicts", aliases: ["evidence", "proof"] },
  { name: "/stats", summary: "false-claim rate, tokens per verified change", aliases: ["metrics"] },
  { name: "/shed", args: "[--explain]", summary: "compact context; the full record is archived" },
  { name: "/regrow", args: "<pattern>", summary: "pull archived context back in by search", aliases: ["recall"] },
  { name: "/archive", args: "[pattern]", summary: "list or search shed batches", aliases: ["exuviae"] },
  { name: "/bom", summary: "context bill of materials, in tokens" },
  { name: "/wire", summary: "exact JSON of the last request" },
  { name: "/budget", args: "<n|off>", summary: "hard token ceiling for this session", aliases: ["tokens", "cost"] },
  { name: "/model", args: "<id>", summary: "switch model" },
  { name: "/molt", summary: "cycle theme" },
  { name: "/clear", summary: "reset the session" },
  { name: "/exit", summary: "quit", aliases: ["quit"] },
];

/** Is `needle` a subsequence of `hay`? Powers /rgw → /regrow. */
export function isSubsequence(needle: string, hay: string): boolean {
  if (needle.length === 0) return true;
  let i = 0;
  for (const ch of hay) {
    if (ch === needle[i]) i++;
    if (i === needle.length) return true;
  }
  return false;
}

type Scored = { command: Command; rank: number };

/**
 * Filter the palette for the text typed so far. Returns every command for a
 * bare "/", so pressing slash previews what is available rather than
 * requiring you to already know.
 */
export function matchCommands(input: string, commands: Command[] = COMMANDS): Command[] {
  const trimmed = input.trim();
  if (!trimmed.startsWith("/")) return [];

  // Once there is an argument, the command is settled — stop suggesting.
  if (/\s/.test(trimmed)) {
    const head = trimmed.split(/\s+/)[0];
    const exact = commands.find((c) => c.name === head);
    return exact ? [exact] : [];
  }

  const query = trimmed.slice(1).toLowerCase();
  if (query.length === 0) return [...commands];

  const scored: Scored[] = [];
  for (const command of commands) {
    const bare = command.name.slice(1).toLowerCase();
    const terms = [bare, ...(command.aliases ?? []).map((a) => a.toLowerCase())];

    let rank = Infinity;
    if (bare === query) rank = 0;
    else if (terms.some((t) => t.startsWith(query))) rank = 1;
    else if (terms.some((t) => isSubsequence(query, t))) rank = 2;
    else if (command.summary.toLowerCase().split(/[^a-z0-9]+/).some((w) => w.startsWith(query)))
      rank = 3;

    if (rank !== Infinity) scored.push({ command, rank });
  }

  scored.sort(
    (a, b) =>
      a.rank - b.rank ||
      a.command.name.length - b.command.name.length ||
      a.command.name.localeCompare(b.command.name),
  );
  return scored.map((s) => s.command);
}

/**
 * What Tab should insert. Completing to the name plus a trailing space when
 * the command takes an argument saves a keystroke and signals that more
 * input is expected.
 */
export function completionFor(command: Command): string {
  return command.args ? `${command.name} ` : command.name;
}

/** Wrap an index into range, so arrow keys cycle instead of dead-ending. */
export function wrapIndex(index: number, length: number): number {
  if (length <= 0) return 0;
  return ((index % length) + length) % length;
}
