/**
 * Remembering the servers you run.
 *
 * molt's own config holds exactly one endpoint — the last one `/login` or
 * `/model` settled on. That is right for a terminal, which points at one thing
 * at a time, and wrong for a list: a second machine on the network was simply
 * never asked, so its models could not appear in the picker. Reported as "the
 * custom models just say other; I need the local models to also show up".
 */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import {
  readEndpoints,
  rememberEndpoint,
  forgetEndpoint,
  normalizeUrl,
} from "../electron/endpoints.js";

function dir(): string {
  return mkdtempSync(join(tmpdir(), "molt-endpoints-"));
}

describe("remembered endpoints", () => {
  it("keeps what it is told, newest first", () => {
    const d = dir();
    try {
      rememberEndpoint("http://127.0.0.1:8080/v1", "qwen", d, "2026-01-01T00:00:00Z");
      rememberEndpoint("http://192.168.0.218:8080/v1", "qwen", d, "2026-01-02T00:00:00Z");
      assert.deepEqual(
        readEndpoints(d).map((e) => e.url),
        ["http://192.168.0.218:8080/v1", "http://127.0.0.1:8080/v1"],
      );
    } finally {
      rmSync(d, { recursive: true, force: true });
    }
  });

  it("does not grow when the same server is used twice", () => {
    const d = dir();
    try {
      rememberEndpoint("http://127.0.0.1:8080/v1", "a", d, "2026-01-01T00:00:00Z");
      rememberEndpoint("http://127.0.0.1:8080/v1", "b", d, "2026-01-02T00:00:00Z");
      const all = readEndpoints(d);
      assert.equal(all.length, 1, "opening the same workspace twice must not duplicate it");
      assert.equal(all[0]!.lastModel, "b", "and the newer visit wins");
    } finally {
      rmSync(d, { recursive: true, force: true });
    }
  });

  it("treats a trailing slash as the same server", () => {
    const d = dir();
    try {
      rememberEndpoint("http://127.0.0.1:8080/v1", "a", d, "2026-01-01T00:00:00Z");
      rememberEndpoint("http://127.0.0.1:8080/v1/", "a", d, "2026-01-02T00:00:00Z");
      assert.equal(readEndpoints(d).length, 1);
      assert.equal(normalizeUrl("http://h/v1///"), "http://h/v1");
    } finally {
      rmSync(d, { recursive: true, force: true });
    }
  });

  it("re-selecting an old server promotes it rather than duplicating it", () => {
    const d = dir();
    try {
      rememberEndpoint("http://a/v1", undefined, d, "2026-01-01T00:00:00Z");
      rememberEndpoint("http://b/v1", undefined, d, "2026-01-02T00:00:00Z");
      rememberEndpoint("http://a/v1", undefined, d, "2026-01-03T00:00:00Z");
      assert.deepEqual(
        readEndpoints(d).map((e) => e.url),
        ["http://a/v1", "http://b/v1"],
      );
    } finally {
      rmSync(d, { recursive: true, force: true });
    }
  });

  it("forgets one without disturbing the others", () => {
    const d = dir();
    try {
      rememberEndpoint("http://a/v1", undefined, d, "2026-01-01T00:00:00Z");
      rememberEndpoint("http://b/v1", undefined, d, "2026-01-02T00:00:00Z");
      forgetEndpoint("http://a/v1", d);
      assert.deepEqual(
        readEndpoints(d).map((e) => e.url),
        ["http://b/v1"],
      );
    } finally {
      rmSync(d, { recursive: true, force: true });
    }
  });

  it("caps the list rather than growing forever", () => {
    const d = dir();
    try {
      for (let i = 0; i < 30; i++)
        rememberEndpoint(`http://h${i}/v1`, undefined, d, `2026-01-01T00:00:${String(i).padStart(2, "0")}Z`);
      const all = readEndpoints(d);
      assert.ok(all.length <= 12, `kept ${all.length}`);
      assert.equal(all[0]!.url, "http://h29/v1", "the newest must survive the cap");
    } finally {
      rmSync(d, { recursive: true, force: true });
    }
  });

  it("survives a file that is not what it expects", () => {
    // A corrupt list is a convenience lost, never a window that will not open.
    const d = dir();
    try {
      writeFileSync(join(d, "desktop-endpoints.json"), "{ this is not json", "utf8");
      assert.deepEqual(readEndpoints(d), []);
      writeFileSync(join(d, "desktop-endpoints.json"), '{"not":"an array"}', "utf8");
      assert.deepEqual(readEndpoints(d), []);
      writeFileSync(join(d, "desktop-endpoints.json"), '[{"nope":1},{"url":"http://ok/v1"}]', "utf8");
      assert.deepEqual(
        readEndpoints(d).map((e) => e.url),
        ["http://ok/v1"],
        "one bad entry must not discard the good ones",
      );
    } finally {
      rmSync(d, { recursive: true, force: true });
    }
  });

  it("ignores an empty url rather than storing a blank row", () => {
    const d = dir();
    try {
      rememberEndpoint("   ", undefined, d, "2026-01-01T00:00:00Z");
      assert.deepEqual(readEndpoints(d), []);
    } finally {
      rmSync(d, { recursive: true, force: true });
    }
  });
});
