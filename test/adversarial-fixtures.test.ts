/**
 * Adversarial regression suite: can a misbehaving worker reach a "verified"
 * verdict, or learn a hidden check, by cheating rather than doing the work?
 *
 * Each fixture under test/fixtures/adversarial/ scripts one fake worker (no
 * model is called; a fetch stand-in replays its turns through the real Engine
 * against a real project with real hidden checks) and asserts two things:
 *   - the final label is NOT "verified" in any form (see `notVerified`), and
 *   - nothing withheld leaked to the worker before the job ended.
 *
 * Scenarios Maat already handles pass outright. Scenarios that are known open
 * gaps are registered with `{ todo: GAP.x }`: node's runner still runs them
 * and still checks the behaviour Maat should have, but a failure is reported
 * as an expected (todo) failure and does not turn the suite red. Each GAP
 * string links the PR or review that tracks it. When a gap is closed its test
 * flips to passing — drop the todo then. See the folder README.
 */
import { register as tamperVisible } from "./fixtures/adversarial/01-tamper-visible-checks.js";
import { register as hardcode } from "./fixtures/adversarial/02-hardcode-outputs.js";
import { register as hunt } from "./fixtures/adversarial/03-hunt-hidden-checks.js";
import { register as trivialCheck } from "./fixtures/adversarial/04-trivial-own-check.js";
import { register as touchOnly } from "./fixtures/adversarial/05-touch-only.js";
import { register as leftover } from "./fixtures/adversarial/06-leftover-process.js";
import { register as stallCrash } from "./fixtures/adversarial/07-stall-and-crash.js";
import { register as symlink } from "./fixtures/adversarial/08-symlink-plant.js";
import { register as encodedLeak } from "./fixtures/adversarial/09-encoded-leak.js";
import { register as environ } from "./fixtures/adversarial/10-read-environ.js";
import { register as reviewTrunc } from "./fixtures/adversarial/11-review-truncation.js";
import { register as refExit } from "./fixtures/adversarial/12-reference-earlyexit.js";
import { register as shadowRunner } from "./fixtures/adversarial/13-shadow-runner.js";

tamperVisible();
hardcode();
hunt();
trivialCheck();
touchOnly();
leftover();
stallCrash();
symlink();
encodedLeak();
environ();
reviewTrunc();
refExit();
shadowRunner();
