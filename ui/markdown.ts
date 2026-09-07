/**
 * Receipts, as DOM.
 *
 * A receipt quotes the model verbatim. This renderer builds nodes and sets
 * text, never HTML — so a `<script>` in the claim stays a string, including
 * inside tables and blockquotes.
 */
export function renderMarkdown(md: string, into: HTMLElement): void {
  const el = (tag: string, cls?: string, text?: string): HTMLElement => {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text !== undefined) n.textContent = text;
    return n;
  };

  const lines = md.split("\n");
  let i = 0;
  const inline = (parent: HTMLElement, text: string): void => {
    const re = /(`[^`]+`|\*\*[^*]+\*\*)/g;
    let last = 0;
    for (const m of text.matchAll(re)) {
      const at = m.index!;
      if (at > last) parent.appendChild(document.createTextNode(text.slice(last, at)));
      const tok = m[0];
      if (tok.startsWith("`")) parent.appendChild(el("code", undefined, tok.slice(1, -1)));
      else parent.appendChild(el("strong", undefined, tok.slice(2, -2)));
      last = at + tok.length;
    }
    if (last < text.length) parent.appendChild(document.createTextNode(text.slice(last)));
  };

  while (i < lines.length) {
    const line = lines[i]!;

    if (line.startsWith("```")) {
      const pre = el("pre");
      const code = el("code");
      i++;
      const buf: string[] = [];
      while (i < lines.length && !lines[i]!.startsWith("```")) buf.push(lines[i++]!);
      i++;
      code.textContent = buf.join("\n");
      pre.appendChild(code);
      into.appendChild(pre);
      continue;
    }

    const h = /^(#{1,4})\s+(.*)$/.exec(line);
    if (h) {
      const node = el(`h${h[1]!.length}`);
      inline(node, h[2]!);
      into.appendChild(node);
      i++;
      continue;
    }

    if (/^\s*\|.*\|\s*$/.test(line) && /^\s*\|[\s:|-]+\|\s*$/.test(lines[i + 1] ?? "")) {
      const cells = (r: string): string[] =>
        r.trim().replace(/^\||\|$/g, "").split("|").map((c) => c.trim());
      const table = el("table");
      const thead = el("thead");
      const hr = el("tr");
      for (const c of cells(line)) {
        const th = el("th");
        inline(th, c);
        hr.appendChild(th);
      }
      thead.appendChild(hr);
      table.appendChild(thead);
      i += 2;
      const tbody = el("tbody");
      while (i < lines.length && /^\s*\|.*\|\s*$/.test(lines[i]!)) {
        const tr = el("tr");
        for (const c of cells(lines[i]!)) {
          const td = el("td");
          inline(td, c);
          tr.appendChild(td);
        }
        tbody.appendChild(tr);
        i++;
      }
      table.appendChild(tbody);
      into.appendChild(table);
      continue;
    }

    if (line.startsWith(">")) {
      const q = el("blockquote");
      const buf: string[] = [];
      while (i < lines.length && lines[i]!.startsWith(">")) buf.push(lines[i++]!.replace(/^>\s?/, ""));
      inline(q, buf.join("\n"));
      q.style.whiteSpace = "pre-wrap";
      into.appendChild(q);
      continue;
    }

    if (/^[-*]\s+/.test(line)) {
      const ul = el("ul");
      while (i < lines.length && /^[-*]\s+/.test(lines[i]!)) {
        const li = el("li");
        inline(li, lines[i]!.replace(/^[-*]\s+/, ""));
        ul.appendChild(li);
        i++;
      }
      into.appendChild(ul);
      continue;
    }

    if (/^---+$/.test(line.trim())) {
      into.appendChild(el("hr"));
      i++;
      continue;
    }

    if (line.trim() === "") {
      i++;
      continue;
    }

    // The first line is consumed unconditionally, because it is the line this
    // pass already refused every other block for. Leaving it to the loop below
    // meant a line that opens a block form without completing it — `##### h5`
    // (the header rule stops at four), `#tag`, a `|` row with no separator
    // beneath it — matched the guard, added nothing to the buffer, and left
    // `i` where it was: an empty <p> appended forever, in the renderer thread,
    // on a receipt the model wrote. A paragraph always eats at least its own
    // first line, and that is what makes this loop terminate.
    const p = el("p");
    const buf: string[] = [lines[i++]!];
    while (i < lines.length && lines[i]!.trim() !== "" && !/^(#|>|```|[-*]\s|\|)/.test(lines[i]!))
      buf.push(lines[i++]!);
    inline(p, buf.join(" "));
    into.appendChild(p);
  }
}
