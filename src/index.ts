/** Public API. Everything here is covered by tests in test/. */
export { Archive, type ArchiveEntry, type ArchiveLike } from "./archive.js";
export {
  BAR_FILENAME,
  BarError,
  DEFAULT_BAR,
  barFingerprint,
  barPath,
  claimedWrites,
  formatBarFailure,
  hasBar,
  loadBar,
  parseBar,
  runBar,
  runCheck,
  writeDefaultBar,
  type BarContext,
} from "./bar.js";
export { Engine, SYSTEM_PROMPT, MAX_PROOF_ATTEMPTS, type EngineConfig } from "./engine.js";
export { Receipts, type Receipt } from "./receipts.js";
export {
  Transcript,
  buildDigest,
  buildExuvia,
  toolDetail,
  DIGEST_HEADER,
  type ShedPlan,
} from "./transcript.js";
export { THEMES, DEFAULT_THEME, getTheme, nextTheme, themeNames, type Theme } from "./theme.js";
export * from "./types.js";
