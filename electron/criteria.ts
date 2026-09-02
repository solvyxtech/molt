/**
 * Desktop re-export of the shared criteria helper.
 *
 * The drafter and the sanitizer live in `src/` so the TUI and the window
 * cannot drift. This file exists so existing `electron/` imports keep working.
 */
export {
  CRITERIA_MAX_CHECKS,
  CRITERIA_MAX_NAME,
  CRITERIA_MAX_NOTE,
  CRITERIA_MAX_NOTES,
  CRITERIA_MAX_RUN,
  draftCriteria,
  sanitizeCriteria,
  taskChecksFrom,
  type Draft,
  type DraftedCheck,
} from "../src/criteria.js";
