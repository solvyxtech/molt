/**
 * The splash, in the window.
 *
 * The terminal molts on launch: four husked letters, `(m) (o) (l) (t)`, each
 * husk splitting a few frames apart and leaving as a wavefront that widens
 * into an arc and dissipates. That animation is not re-drawn here — the frames
 * come from `src/banner-frames.ts`, the same pure builder Ink renders, so the
 * two surfaces are one animation painted by two different things. A span per
 * colour-run is the window's equivalent of a `<Text color>`.
 *
 * Then the window does the one thing a terminal cannot, and it is the reason
 * this exists rather than being a copy: the wavefronts do not simply die at
 * the edge. Each one that comes off the word curls, and the arcs it leaves
 * behind settle onto a logarithmic spiral — which is what a nautilus is. By
 * the time the water is still the cast husks have built the shell, and the
 * mark fades up out of it, in the place it was going to sit anyway.
 *
 * That is the whole conceit of the name made literal: what the word sheds is
 * what the logo is made of.
 *
 * Ceremony is never a toll booth. Any key or click skips to the settled frame,
 * the same as the terminal, and `prefers-reduced-motion` skips it entirely.
 * It plays once per launch — a splash you have to watch twice is a splash
 * people learn to resent.
 */
import {
  buildFrame,
  COLS,
  FRAME_MS,
  SETTLED_FRAME,
  type Segment,
  type Tone,
} from "../src/banner-frames.js";

/** The column a wavefront has reached when it dissipates, from the builder's
 *  own numbers: ORIGIN + (RIPPLE_LIFETIME - 1) × TRAVEL. The spiral starts
 *  where the waves stop, so the hand-off has no seam in it. */
const WAVE_DIES_AT = 45;

/** Chambers in the shell. Enough to read as a coil, few enough to stay drawn
 *  in the same `)` the terminal uses rather than becoming a texture. */
const ARCS = 34;
const TURNS = 1.85;
/** Radius of the innermost chamber, in px. Below this the glyph is a dot. */
const R_IN = 11;

/** The first arc lands two frames after the first husk splits, the last as the
 *  final wavefront dies — so a chamber is always arriving while water moves. */
const FIRST_ARC = 4;
const LAST_ARC = 22;

/** Frames before the settle at which the mark starts fading up through it.
 *  After the last chamber lands, not during: the shell should be whole for a
 *  beat before it becomes the thing it was building. */
const REVEAL_BEFORE = 2;

/** Breathing room the picture wants either side of it, in px. Below that the
 *  splash is skipped and the mark simply appears — the same call the terminal
 *  makes with MIN_COLUMNS, asked in the unit this surface measures in. */
const GUTTER = 24;

const TONE_CLASS: Record<Tone, string> = {
  accent: "t-accent",
  mid: "t-mid",
  dim: "t-dim",
  ghost: "t-ghost",
};

let played = false;

/** Where arc `i` sits, as an offset in px from the centre of the mark. */
function arcAt(i: number, r0: number): { x: number; y: number; r: number; deg: number } {
  const u = i / (ARCS - 1);
  const theta = u * TURNS * 2 * Math.PI;
  // Geometric decay, which is what makes it a logarithmic spiral rather than
  // a coil of hose: every turn shrinks the radius by the same ratio.
  const r = r0 * Math.pow(R_IN / r0, u);
  return {
    // Screen y grows downward, so negating it winds the coil the same way the
    // mark's own does instead of mirroring it.
    x: r * Math.cos(theta),
    y: -r * Math.sin(theta),
    r,
    deg: (-theta * 180) / Math.PI,
  };
}

function rowNodes(segs: Segment[]): DocumentFragment {
  const frag = document.createDocumentFragment();
  for (const s of segs) {
    const span = document.createElement("span");
    span.className = TONE_CLASS[s.tone];
    span.textContent = s.text;
    frag.appendChild(span);
  }
  return frag;
}

/**
 * Play the splash inside an empty-session block, once.
 *
 * `stage` is the box the mark occupies; the grid and the shell are drawn over
 * it and allowed to overflow, so nothing in the column below moves while the
 * water is still going.
 */
export function playSplash(empty: HTMLElement): void {
  if (played) return;
  played = true;

  const stage = empty.querySelector<HTMLElement>(".mark-stage");
  const mark = empty.querySelector<HTMLElement>(".empty-mark");
  if (!stage || !mark) return;

  const reduced = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;
  if (reduced || stage.getBoundingClientRect().width === 0) return;

  const grid = document.createElement("pre");
  grid.className = "splash-grid";
  grid.setAttribute("aria-hidden", "true");
  const shell = document.createElement("div");
  shell.className = "splash-shell";
  shell.setAttribute("aria-hidden", "true");
  stage.appendChild(grid);
  stage.appendChild(shell);

  // Measured, not assumed: the spiral has to start where the grid's own waves
  // end, and that depends on whatever monospace face the platform resolved.
  // An empty <pre> has no width, so it is given a full row to measure against
  // before the first frame replaces it.
  grid.textContent = "M".repeat(COLS);
  const gridWidth = grid.getBoundingClientRect().width;
  // Does it fit, rather than is it wider than some number: the grid is a fixed
  // 60 columns of whatever monospace the platform resolved, so the only
  // question worth asking is whether the panel has room for it.
  const room = empty.getBoundingClientRect().width;
  if (gridWidth === 0 || gridWidth + GUTTER * 2 > room) {
    grid.remove();
    shell.remove();
    return;
  }
  // Pinned to the full 60 columns. The builder trims each row's trailing
  // whitespace — a terminal should never repaint padding — so a shrink-wrapped
  // <pre> is a different width every frame, and a box that is centred on its
  // own changing width walks the word across the screen while it molts.
  grid.style.width = `${gridWidth}px`;
  const r0 = (WAVE_DIES_AT - COLS / 2) * (gridWidth / COLS);

  const arcs: HTMLElement[] = [];
  for (let i = 0; i < ARCS; i++) {
    const { x, y, r, deg } = arcAt(i, r0);
    const a = document.createElement("i");
    a.className = "arc";
    a.style.transform = `translate(calc(-50% + ${x.toFixed(1)}px), calc(-50% + ${y.toFixed(1)}px)) rotate(${deg.toFixed(1)}deg)`;
    // A chamber is drawn at the size of the chamber, which is what makes the
    // coil read as one shell growing rather than thirty brackets on a curve.
    // The factor is set against the spacing: consecutive chambers sit about
    // r × Δθ apart, so anything above ~0.4 draws them into each other and the
    // coil turns into a blot instead of a shell.
    a.style.fontSize = `${Math.min(34, Math.max(8, r * 0.3)).toFixed(1)}px`;
    // The glyph is nested so its arrival can be scaled without touching the
    // transform that places it: the individual `scale` property composes
    // outside `transform`, which would scale the offset and move the chamber.
    const glyph = document.createElement("b");
    glyph.textContent = ")";
    a.appendChild(glyph);
    shell.appendChild(a);
    arcs.push(a);
  }

  empty.classList.add("splashing");

  let frame = 0;
  let timer: ReturnType<typeof setInterval> | null = null;

  const draw = (f: number): void => {
    grid.textContent = "";
    for (const segs of buildFrame(f)) {
      const line = document.createElement("div");
      if (segs.length === 0) line.textContent = " ";
      else line.appendChild(rowNodes(segs));
      grid.appendChild(line);
    }
    for (let i = 0; i < arcs.length; i++) {
      const appear = FIRST_ARC + (i * (LAST_ARC - FIRST_ARC)) / (ARCS - 1);
      const age = f - appear;
      const a = arcs[i]!;
      a.classList.toggle("in", age >= 0);
      a.classList.toggle("hot", age >= 0 && age < 4);
    }
    // The mark comes up through the finished coil rather than after it, so
    // there is a moment where the shell and the thing it became are both on
    // screen — which is the only frame that says they are the same object.
    if (f >= SETTLED_FRAME - REVEAL_BEFORE) empty.classList.add("revealing");
  };

  const finish = (): void => {
    if (timer) clearInterval(timer);
    timer = null;
    grid.remove();
    shell.remove();
    empty.classList.remove("splashing", "revealing");
    document.removeEventListener("keydown", skip, true);
    document.removeEventListener("mousedown", skip, true);
  };

  function skip(): void {
    finish();
  }

  document.addEventListener("keydown", skip, true);
  document.addEventListener("mousedown", skip, true);

  draw(0);
  timer = setInterval(() => {
    // The first turn removes the whole empty block. Nothing below should keep
    // ticking against a stage that is no longer in the document.
    if (!document.contains(stage)) {
      finish();
      return;
    }
    frame += 1;
    draw(frame);
    if (frame >= SETTLED_FRAME) {
      // Long enough for the mark's fade and the shell's to cross.
      if (timer) clearInterval(timer);
      timer = setTimeout(finish, 520) as unknown as ReturnType<typeof setInterval>;
    }
  }, FRAME_MS);
}
