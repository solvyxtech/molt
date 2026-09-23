/**
 * A tool call written as text is not a tool call.
 *
 * Models imitate the transcript they are shown. After a shed or a compaction
 * the conversation holds digests and exuviae that *describe* calls — lines
 * like `write_file: src/a.ts`, JSON blocks of `tool_calls` — and a weak model,
 * or a strong one trained on another harness's wire format, answers in kind:
 * it writes `<tool_call>{"name": "write_file", …}</tool_call>` into its reply,
 * sometimes a `[Tool result] wrote 12 bytes` beneath it, and then "Done — the
 * file is created." No tool ran. The provider returned no `tool_calls`, so
 * molt read the message the only way the loop could: as a claim of completion.
 *
 * This finds that shape in assistant text. It is deliberately narrow, because
 * the cost of the two errors is not symmetric: a miss costs one bar run that
 * `files-changed` will usually refuse anyway, while a false positive costs a
 * request and tells a model that answered correctly that it did not.
 *
 *  - Harness markup (`<tool_call>`, `<function_calls>`/`<invoke name=`,
 *    `<function=…>`, `[TOOL_CALLS]`, `[Assistant tool call]`, fake
 *    `[Tool result]` blocks) counts in prose. Nobody writes those in an answer
 *    except to show them, and showing is done in code.
 *  - Inline code is not prose: `` `<tool_call>` `` in a sentence is a model
 *    talking *about* the format, and is removed before anything is read.
 *  - A fenced block is code, and a code block in an answer is ordinary — a
 *    review quoting molt's own tests, an ask-mode answer explaining a wire
 *    format. A fence counts only when its body *is* a call (starts with the
 *    markup, or parses as call-shaped JSON naming a real tool) AND it sits
 *    where an action would: last in the message, led in by "I'll now…", or
 *    followed by a fabricated result.
 *  - Prose naming a tool counts only as an action in the present or future
 *    tense aimed at one of molt's tools — "I'll now call write_file(…)",
 *    "Calling edit_file with …", `read_file(path="a.ts")`. "I used grep to
 *    find it" is a report of something that ran and is left alone.
 *
 * Returns what it found, in words a model can act on, or null.
 */

/** molt's own tools. Names outside this set only count inside harness markup. */
export const MOLT_TOOL_NAMES = [
  "read_file",
  "write_file",
  "list_dir",
  "grep",
  "edit_file",
  "bash",
] as const;

/** Markup no answer contains except by imitating a harness. Label, pattern. */
const MARKUP: [string, RegExp][] = [
  ["a Hermes/Qwen-style `<tool_call>` block", /<\/?tool_call>/i],
  ["an XML `<function_calls>`/`<invoke>` block", /<function_calls>|<invoke\s+name\s*=/i],
  ["a `<function=…>` call block", /<function=[\w.-]+>|<parameter=[\w.-]+>/],
  ["a `[TOOL_CALLS]` marker", /\[TOOL_CALLS\]/],
  [
    "a special-token tool-call marker",
    /<[|｜]\s*tool[▁_ ]calls?[▁_ ](?:section[▁_ ])?begin\s*[|｜]>|<\|python_tag\|>|<\|tool_call\|>/,
  ],
  ["a `<tool_code>`/`<tool_use>` block", /<\/?tool_(?:code|use)>/i],
  ["a `[tool call]` transcript line", /\[(?:assistant\s+)?tool[ _-]?calls?\b[^\]\n]{0,80}\]/i],
];

/** A result written by the model rather than returned by a tool. */
const FAKE_RESULT: RegExp[] = [
  /\[(?:tool|function)[ _-]?(?:results?|outputs?|responses?)\b[^\]\n]{0,80}\]/i,
  /<\/?(?:tool_result|tool_response|function_results?)>/i,
];

/** Words that lead into an action, on the line before a fenced call. */
const LEAD_IN =
  /\b(?:I'll|I will|I'm going to|I am going to|let me|let's|now|next|calling|invoking|executing)\b/i;

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Is this parsed value shaped like a tool call naming one of `tools`? */
function callShaped(v: unknown, tools: ReadonlySet<string>): boolean {
  if (Array.isArray(v)) return v.length > 0 && v.every((x) => callShaped(x, tools));
  if (!v || typeof v !== "object") return false;
  const o = v as Record<string, unknown>;
  if (Array.isArray(o.tool_calls)) return callShaped(o.tool_calls, tools);
  // OpenAI wire shape: { type: "function", function: { name, arguments } }.
  if (o.function && typeof o.function === "object") {
    return callShaped(o.function, tools);
  }
  const name = o.name ?? o.tool ?? o.tool_name ?? o.recipient_name;
  if (typeof name !== "string" || !tools.has(name.replace(/^functions\./, ""))) return false;
  return ["arguments", "parameters", "args", "input"].some((k) => k in o);
}

function parseJson(body: string): unknown {
  try {
    return JSON.parse(body);
  } catch {
    return undefined;
  }
}

type Segment = { fence: false; text: string } | { fence: true; lang: string; body: string };

/** Split on ``` fences. An unclosed fence runs to the end, as markdown does. */
function segments(text: string): Segment[] {
  const out: Segment[] = [];
  const re = /^[ \t]*(`{3,}|~{3,})[ \t]*([\w+-]*)[^\n]*\n([\s\S]*?)(?:^[ \t]*\1[ \t]*$|(?![\s\S]))/gm;
  let at = 0;
  for (let m: RegExpExecArray | null; (m = re.exec(text)); ) {
    if (m.index > at) out.push({ fence: false, text: text.slice(at, m.index) });
    out.push({ fence: true, lang: m[2]!.toLowerCase(), body: m[3]! });
    at = m.index + m[0].length;
    if (m[0].length === 0) re.lastIndex++;
  }
  if (at < text.length) out.push({ fence: false, text: text.slice(at) });
  return out;
}

/**
 * Prose with inline code taken out. A span that is a bare identifier is kept
 * without its backticks — "Calling `write_file` with …" is still an action —
 * and anything else in backticks is somebody quoting syntax.
 */
function prose(text: string): string {
  return text.replace(/(`+)([^`\n]*?)\1/g, (_, _t, inner: string) =>
    /^[\w.-]+$/.test(inner.trim()) ? inner.trim() : " ",
  );
}

export function narratedCallIn(
  text: string,
  toolNames: readonly string[] = MOLT_TOOL_NAMES,
): string | null {
  if (!text.trim()) return null;
  const tools = new Set(toolNames);
  const names = toolNames.map(escape).join("|");
  const segs = segments(text);
  const plain = segs
    .filter((s): s is Extract<Segment, { fence: false }> => !s.fence)
    .map((s) => prose(s.text))
    .join("\n");

  const fakeResult = FAKE_RESULT.some((re) => re.test(plain));

  // Markup counts when something call-shaped follows it: one of molt's tool
  // names, a JSON body, or parameter tags. A sentence that merely names the
  // format — "Hermes models emit <tool_call> tags" — has none of those.
  const oursNear = new RegExp(`\\b(?:${names})\\b|\\{\\s*"|<parameter|<invoke|"name"\\s*:`);
  for (const [label, re] of MARKUP) {
    const hit = re.exec(plain);
    if (hit && oursNear.test(plain.slice(hit.index + hit[0].length, hit.index + 400))) {
      return `it contains ${label}`;
    }
  }

  // Bare call-shaped JSON in prose. Found by the key rather than by parsing
  // every brace, and only for a tool molt actually has.
  const jsonName = new RegExp(
    `"(?:name|tool|tool_name)"\\s*:\\s*"(?:functions\\.)?(${names})"`,
  );
  const jsonArgs = /"(?:arguments|parameters|args|input)"\s*:/;
  const nameHit = jsonName.exec(plain);
  if (nameHit) {
    const near = plain.slice(Math.max(0, nameHit.index - 400), nameHit.index + 400);
    if (jsonArgs.test(near)) return `it contains a JSON tool call to \`${nameHit[1]}\` written as text`;
  }

  // `write_file(path="a.ts", …)` — call syntax with arguments, outside code.
  const callSyntax = new RegExp(`\\b(${names})\\(\\s*(?:\\{|["']|\\w+\\s*=)`);
  const syn = callSyntax.exec(plain);
  if (syn) return `it writes out a call to \`${syn[1]}(…)\` as text`;

  // Announced, in the present or future tense, and not made.
  const intent = new RegExp(
    `\\b(?:I'll|I will|I'm going to|I am going to|let me|let's)\\s+` +
      `(?:now\\s+|first\\s+|next\\s+|then\\s+|go ahead and\\s+)?` +
      `(?:call|invoke|use|run|execute)\\s+(?:the\\s+)?(${names})(?:\\s+tool)?` +
      `\\s*(?:\\(|with\\b|on\\b|to\\b|for\\b|:)`,
    "i",
  );
  const said = intent.exec(plain);
  if (said) return `it says it will call \`${said[1]}\``;
  const calling = new RegExp(
    `^[ \\t]*(?:[-*>][ \\t]+)?(?:\\*\\*|__)?(?:Calling|Invoking)\\s+(?:the\\s+)?(${names})\\b`,
    "m",
  );
  const now = calling.exec(plain);
  if (now) return `it narrates "Calling ${now[1]}" instead of calling it`;

  // Fenced blocks: a call-shaped body in the place an action goes.
  for (let i = 0; i < segs.length; i++) {
    const s = segs[i]!;
    if (!s.fence) continue;
    const body = s.body.trim();
    let shaped: string | null = null;
    // Markup in a fence has to name one of molt's tools: a block showing the
    // format with `get_weather` in it is documentation, not an attempt.
    const namesOurs = new RegExp(`\\b(?:${names})\\b`).test(body);
    if (/^tool[_-]?(?:call|code|use)s?$/.test(s.lang) && namesOurs) {
      shaped = `a \`${s.lang}\` code block`;
    } else if (namesOurs && MARKUP.some(([, re]) => re.test(body.slice(0, 80)))) {
      shaped = "tool-call markup in a code block";
    } else if (["", "json", "jsonc", "json5", "javascript", "js"].includes(s.lang)) {
      if (callShaped(parseJson(body), tools)) shaped = "a JSON tool call in a code block";
    }
    if (!shaped && ["", "python", "py", "text"].includes(s.lang)) {
      if (new RegExp(`^(?:${names})\\s*\\(`).test(body) && !/\n\s*\S/.test(body.replace(/\)\s*$/, ""))) {
        shaped = "a call written as code";
      }
    }
    if (!shaped) continue;

    // Where it sits. An example sits inside an explanation; an action is the
    // last thing said, or introduced as one, or followed by its "result".
    const after = segs
      .slice(i + 1)
      .map((x) => (x.fence ? x.body : x.text))
      .join("")
      .trim();
    const before = segs[i - 1];
    const leadLine =
      before && !before.fence ? (before.text.trimEnd().split("\n").at(-1) ?? "") : "";
    const trailing = after === "" || FAKE_RESULT.some((re) => re.test(after.slice(0, 200)));
    if (trailing || fakeResult || LEAD_IN.test(leadLine) || /^tool/.test(s.lang)) {
      return `it contains ${shaped}`;
    }
  }

  if (fakeResult) return "it contains a tool result that no tool returned";
  return null;
}

/** What the model is told. Said in the transcript, where it can act on it. */
export function narratedCallNudge(why: string): string {
  return (
    `[molt: that reply contains text shaped like a tool call — ${why} — and made no ` +
    `tool call. Text in a reply is never executed: nothing ran, no file was read or ` +
    `written, and any result shown in it was written by you rather than returned by ` +
    `a tool. To do the work, make a real call through the tools you were given. If ` +
    `the work was already done by earlier calls, say what they did in plain words, ` +
    `without imitating a call or its output.]`
  );
}
