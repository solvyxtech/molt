/**
 * The weighing, once per launch.
 *
 * Grok's splash for the Maat page, in the window: a claim on one side of the
 * beam, the feather on the other, the beam settling level, then "Weighed, then
 * done." A click, any key, or the scale settling (2.7 s) lets you in; the
 * picture then fades rather than vanishing. prefers-reduced-motion shows the
 * settled picture and lets you straight in.
 *
 * Ceremony is never a toll booth: it plays once, and anything you do ends it.
 */
const SETTLE_MS = 2_700;
const FADE_MS = 420;

export function playMaatSplash(): void {
  const splash = document.getElementById("maat-splash");
  if (!splash) return;
  let finished = false;
  const reduced = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;
  const finish = (): void => {
    if (finished) return;
    finished = true;
    window.removeEventListener("keydown", finish, true);
    splash.classList.add("is-leaving");
    window.setTimeout(() => splash.classList.add("is-gone"), reduced ? 0 : FADE_MS);
    window.dispatchEvent(new Event("maat-splash-done"));
  };
  if (reduced) splash.classList.add("is-settled");
  window.setTimeout(finish, reduced ? 0 : SETTLE_MS);
  splash.addEventListener("click", finish);
  // Capture phase, so the key that skips the splash does not also land in
  // whatever field has focus behind it.
  window.addEventListener("keydown", finish, true);
}
