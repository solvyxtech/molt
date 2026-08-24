/**
 * The desktop shell's own checks.
 *
 * `npm test` is the engine's suite. These cover the window's IPC and chrome —
 * the parts that have never been run on two of the three platforms they ship
 * to, and that a green engine suite cannot see.
 */
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { receiptBasename, resolveReceipt } from "../electron/receipts-path.js";
import { desktopSurfaces } from "../electron/theme-surfaces.js";
import { getTheme } from "../src/theme.js";
import { sessionOpenReject } from "../electron/session-open.js";

/** The nearest ancestor holding a package.json. */
function repoRoot(): string {
  let dir = path.dirname(new URL(import.meta.url).pathname);
  for (let i = 0; i < 8; i++) {
    if (existsSync(path.join(dir, "package.json"))) return dir;
    dir = path.dirname(dir);
  }
  throw new Error("could not find the project root from " + import.meta.url);
}

describe("receipts:read containment", () => {
  it("accepts a receipt on POSIX", () => {
    const dir = path.posix.resolve("/proj/.molt/receipts");
    const p = resolveReceipt(dir, "0001-accepted.md", path.posix);
    assert.equal(p, "/proj/.molt/receipts/0001-accepted.md");
  });

  it("accepts a receipt on Windows", () => {
    // The bug: startsWith(dir + "/") against a backslash path never matches,
    // so every legitimate read returns null and the Receipts tab is empty.
    const dir = path.win32.resolve("C:\\proj\\.molt\\receipts");
    const p = resolveReceipt(dir, "0001-accepted.md", path.win32);
    assert.equal(
      p,
      "C:\\proj\\.molt\\receipts\\0001-accepted.md",
      "a Windows receipt must resolve, not vanish behind a POSIX slash",
    );
  });

  it("refuses a climb on both platforms", () => {
    assert.equal(
      resolveReceipt("/proj/.molt/receipts", "../secret.md", path.posix),
      null,
    );
    assert.equal(
      resolveReceipt("C:\\proj\\.molt\\receipts", "..\\secret.md", path.win32),
      null,
    );
    assert.equal(
      resolveReceipt("C:\\proj\\.molt\\receipts", "C:\\Windows\\win.ini", path.win32),
      null,
    );
  });

  it("refuses a sibling that only shares a prefix", () => {
    // startsWith(dir) without a separator would let receipts-evil through.
    assert.equal(
      resolveReceipt("/proj/.molt/receipts", "../receipts-evil/x.md", path.posix),
      null,
    );
    assert.equal(
      resolveReceipt("C:\\proj\\.molt\\receipts", "..\\receipts-evil\\x.md", path.win32),
      null,
    );
  });

  it("refuses the empty string, a non-string, and the directory itself", () => {
    const dir = "/proj/.molt/receipts";
    assert.equal(resolveReceipt(dir, "", path.posix), null);
    assert.equal(resolveReceipt(dir, 1, path.posix), null);
    assert.equal(resolveReceipt(dir, undefined, path.posix), null);
    assert.equal(resolveReceipt(dir, ".", path.posix), null);
  });

  it("takes only the basename off a Windows receipt path", () => {
    assert.equal(receiptBasename("C:\\proj\\.molt\\receipts\\0001-accepted.md"), "0001-accepted.md");
    assert.equal(receiptBasename("/proj/.molt/receipts/0001-accepted.md"), "0001-accepted.md");
  });
});

describe("session:open input", () => {
  it("refuses a second workspace while a turn is running", () => {
    const d = mkdtempSync(path.join(tmpdir(), "molt-open-"));
    try {
      const err = sessionOpenReject({ cwd: d, model: "x", baseUrl: "http://h/v1" }, true);
      assert.match(err ?? "", /turn is running/);
    } finally {
      rmSync(d, { recursive: true, force: true });
    }
  });

  it("refuses a cwd that is a file, missing, empty, or not a string", () => {
    const d = mkdtempSync(path.join(tmpdir(), "molt-open-"));
    const file = path.join(d, "note.txt");
    writeFileSync(file, "x\n");
    try {
      assert.match(sessionOpenReject({ cwd: file, model: "x", baseUrl: "http://h" }, false) ?? "", /not a directory/);
      assert.match(sessionOpenReject({ cwd: path.join(d, "nope"), model: "x", baseUrl: "http://h" }, false) ?? "", /no such directory/);
      assert.match(sessionOpenReject({ cwd: "", model: "x", baseUrl: "http://h" }, false) ?? "", /no such directory/);
      assert.match(sessionOpenReject(undefined, false) ?? "", /no such directory/);
      assert.match(sessionOpenReject("not-an-object", false) ?? "", /no such directory/);
    } finally {
      rmSync(d, { recursive: true, force: true });
    }
  });

  it("accepts a real directory when nothing is running", () => {
    const d = mkdtempSync(path.join(tmpdir(), "molt-open-"));
    try {
      assert.equal(sessionOpenReject({ cwd: d, model: "x", baseUrl: "http://h" }, false), null);
    } finally {
      rmSync(d, { recursive: true, force: true });
    }
  });
});

describe("desktop theme surfaces", () => {
  it("keeps tidepool's backgrounds when the theme is tidepool", () => {
    const s = desktopSurfaces(getTheme("tidepool"));
    assert.equal(s.bg.toLowerCase(), "#05171d");
    assert.equal(s.line.toLowerCase(), "#0e3744");
  });

  it("does not leave tidepool backgrounds on mono or slate", () => {
    // getTheme() returns seven colours. The stylesheet invented five more
    // and never updated them, so switching theme recoloured the accent and
    // left the window tidepool-coloured. Surfaces must move with the theme.
    const mono = desktopSurfaces(getTheme("mono"));
    const slate = desktopSurfaces(getTheme("slate"));
    assert.notEqual(mono.bg.toLowerCase(), "#05171d");
    assert.notEqual(slate.bg.toLowerCase(), "#05171d");
    assert.notEqual(mono.line.toLowerCase(), "#0e3744");
    assert.equal(mono.line.toLowerCase(), getTheme("mono").ghost.toLowerCase());
    assert.equal(slate.line.toLowerCase(), getTheme("slate").ghost.toLowerCase());
  });
});

describe("title bar padding", () => {
  it("does not reserve 86px for traffic lights on every platform", () => {
    // Walked up to, not guessed at: this file runs from dist-test/test/ once
    // compiled, so a path relative to it lands in the build output rather than
    // the source it means to read.
    const css = readFileSync(path.join(repoRoot(), "ui", "styles.css"), "utf8");
    // The 86px inset is a macOS traffic-light compensation. On Windows and
    // Linux the frame is drawn by the OS, and the same padding is a hole.
    assert.match(css, /\[data-platform=["']darwin["']\][^{]*\.titlebar/);
    const unguarded = /^\s*padding:\s*0\s+var\(--pad\)\s+0\s+86px/m.test(css);
    assert.equal(unguarded, false, "86px must not be the default padding");
  });
});
