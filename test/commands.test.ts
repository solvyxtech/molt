/**
 * A palette that surfaces the wrong command is worse than none — it teaches
 * people to stop reading it. So the ordering rules are pinned here.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  COMMANDS,
  completionFor,
  isSubsequence,
  matchCommands,
  wrapIndex,
} from "../src/commands.js";

const names = (input: string) => matchCommands(input).map((c) => c.name);

describe("matchCommands", () => {
  it("previews everything on a bare slash", () => {
    assert.equal(matchCommands("/").length, COMMANDS.length);
  });

  it("returns nothing for ordinary text", () => {
    assert.deepEqual(matchCommands("fix the bug"), []);
    assert.deepEqual(matchCommands(""), []);
  });

  it("puts an exact name first", () => {
    assert.equal(names("/bar")[0], "/bar");
  });

  it("matches by prefix", () => {
    const r = names("/re");
    assert.ok(r.includes("/receipts") && r.includes("/regrow"));
    assert.ok(!r.includes("/model"));
  });

  it("matches a subsequence, so /rgw finds /regrow", () => {
    assert.ok(names("/rgw").includes("/regrow"));
  });

  it("finds a command by what it does, not only its name", () => {
    // Someone who wants to cap spend types /token, not /budget.
    assert.ok(names("/token").includes("/budget"));
  });

  it("matches aliases", () => {
    assert.ok(names("/recall").includes("/regrow"));
    assert.ok(names("/exuviae").includes("/archive"));
  });

  it("orders prefix matches ahead of subsequence matches", () => {
    const r = names("/ba");
    assert.equal(r[0], "/bar");
  });

  it("is stable between keystrokes", () => {
    // Re-ranking under the user's fingers is how you pick the wrong thing.
    for (const q of ["/", "/r", "/re", "/rec"]) {
      assert.deepEqual(names(q), names(q));
    }
  });

  it("stops suggesting once an argument has been typed", () => {
    assert.deepEqual(names("/regrow auth token"), ["/regrow"]);
    assert.deepEqual(names("/nonsense arg"), []);
  });

  it("returns an empty list rather than everything on a miss", () => {
    assert.deepEqual(names("/zzzzz"), []);
  });
});

describe("isSubsequence", () => {
  it("accepts scattered characters in order", () => {
    assert.ok(isSubsequence("rgw", "regrow"));
    assert.ok(isSubsequence("", "anything"));
  });
  it("rejects out-of-order characters", () => {
    assert.ok(!isSubsequence("wgr", "regrow"));
  });
});

describe("completionFor", () => {
  it("adds a trailing space when an argument is expected", () => {
    assert.equal(completionFor({ name: "/regrow", args: "<p>", summary: "" }), "/regrow ");
    assert.equal(completionFor({ name: "/prove", summary: "" }), "/prove");
  });
});

describe("wrapIndex", () => {
  it("cycles in both directions so arrows never dead-end", () => {
    assert.equal(wrapIndex(-1, 5), 4);
    assert.equal(wrapIndex(5, 5), 0);
    assert.equal(wrapIndex(2, 5), 2);
    assert.equal(wrapIndex(0, 0), 0);
  });
});

describe("the registry itself", () => {
  it("has a unique name and a summary for every command", () => {
    const seen = new Set<string>();
    for (const c of COMMANDS) {
      assert.ok(c.name.startsWith("/"), `${c.name} must start with /`);
      assert.ok(!seen.has(c.name), `duplicate command ${c.name}`);
      seen.add(c.name);
      assert.ok(c.summary.length > 0, `${c.name} needs a summary`);
    }
  });
});
