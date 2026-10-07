/**
 * A tool call's arguments, held against the tool's own schema before it runs.
 *
 * Models drift from a schema in small ways — `file_path` for `path`, a count
 * as "5", `content` missing from a write — and a call that runs anyway runs
 * as something else: a write of `undefined`, a read of the project root, an
 * edit that matches nothing. The error that comes back then is about the
 * wrong thing, and the model debugs a path it never meant. On 2026-10-05 the
 * same class of drift in batch mode turned Nemotron's writes into claims of
 * being finished.
 *
 * So the call is checked first, and a violation is answered with exactly what
 * is wrong and nothing is run. Only the unambiguous is mended on the way: a
 * numeric string where a number is wanted, "true"/"false" where a boolean is,
 * a lone string where a list of strings is. Everything else is said, never
 * guessed — a guessed argument is a different call.
 */

type Prop = { type?: string; enum?: unknown[]; items?: { type?: string } };
type Params = { properties?: Record<string, Prop>; required?: readonly string[] };

/** What is wrong with `args` for this schema; empty when nothing is. Mends the unambiguous in place. */
export function argumentProblems(params: Params | undefined, args: Record<string, unknown>): string[] {
  if (!params?.properties) return [];
  const props = params.properties;
  const problems: string[] = [];
  const unknown = Object.keys(args).filter((k) => !(k in props));
  for (const key of params.required ?? []) {
    if (args[key] !== undefined && args[key] !== null) continue;
    const near = unknown.find((u) => similar(u, key));
    problems.push(`\`${key}\` is required${near ? ` (you sent \`${near}\`; the field is \`${key}\`)` : ""}`);
  }
  for (const [key, spec] of Object.entries(props)) {
    const v = args[key];
    if (v === undefined || v === null || !spec.type) continue;
    const mended = mend(spec, v);
    if (mended.ok) {
      args[key] = mended.value;
      continue;
    }
    problems.push(`\`${key}\` must be ${article(spec.type)}${spec.type === "array" && spec.items?.type ? ` of ${spec.items.type}s` : ""}, not ${describe(v)}`);
  }
  for (const [key, spec] of Object.entries(props)) {
    if (spec.enum && args[key] !== undefined && !spec.enum.includes(args[key])) {
      problems.push(`\`${key}\` must be one of ${spec.enum.map((e) => JSON.stringify(e)).join(", ")}`);
    }
  }
  return problems;
}

function mend(spec: Prop, v: unknown): { ok: true; value: unknown } | { ok: false } {
  switch (spec.type) {
    case "string":
      return typeof v === "string" ? { ok: true, value: v } : { ok: false };
    case "number":
    case "integer": {
      if (typeof v === "number" && Number.isFinite(v)) return { ok: true, value: v };
      if (typeof v === "string" && /^\s*-?\d+(\.\d+)?\s*$/.test(v)) return { ok: true, value: Number(v) };
      return { ok: false };
    }
    case "boolean":
      if (typeof v === "boolean") return { ok: true, value: v };
      if (v === "true" || v === "false") return { ok: true, value: v === "true" };
      return { ok: false };
    case "array": {
      const want = spec.items?.type;
      if (Array.isArray(v)) {
        if (want === "string" && !v.every((x) => typeof x === "string")) return { ok: false };
        return { ok: true, value: v };
      }
      if (want === "string" && typeof v === "string") return { ok: true, value: [v] };
      return { ok: false };
    }
    case "object":
      return v && typeof v === "object" && !Array.isArray(v) ? { ok: true, value: v } : { ok: false };
    default:
      return { ok: true, value: v };
  }
}

/** `file_path` ~ `path`, `old` ~ `old_text`, `cmd` ~ `command`: shares a word or a long prefix. */
function similar(a: string, b: string): boolean {
  const words = (s: string) => s.toLowerCase().split(/[_\-\s]+|(?=[A-Z])/).filter(Boolean);
  const wa = words(a);
  const wb = words(b);
  if (wa.some((w) => wb.includes(w))) return true;
  const x = a.toLowerCase();
  const y = b.toLowerCase();
  return (x.length >= 3 && y.startsWith(x)) || (y.length >= 3 && x.startsWith(y));
}

function article(type: string): string {
  return /^[aeiou]/.test(type) ? `an ${type}` : `a ${type}`;
}

function describe(v: unknown): string {
  if (Array.isArray(v)) return "an array";
  if (typeof v === "string") return `the string ${JSON.stringify(v.length > 40 ? `${v.slice(0, 40)}…` : v)}`;
  return article(typeof v);
}
