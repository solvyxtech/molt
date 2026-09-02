/** Public API. Everything here is covered by tests in test/. */
export { Archive, type ArchiveEntry, type ArchiveLike } from "./archive.js";
export {
  BAR_FILENAME,
  BarError,
  FALLBACK_BAR,
  barFingerprint,
  barPath,
  claimedWrites,
  claimedCreated,
  formatBarFailure,
  hasBar,
  loadBar,
  parseBar,
  runBar,
  runCheck,
  writeDefaultBar,
  type BarContext,
} from "./bar.js";
export {
  Engine,
  SYSTEM_PROMPT,
  systemPromptFor,
  readOnlyRefusal,
  MAX_PROOF_ATTEMPTS,
  type EngineConfig,
  type GitPolicy,
} from "./engine.js";
export { Integrity, type IntegrityEvent, type IntegrityRecord, INTEGRITY_GENESIS } from "./integrity.js";
export {
  commitMessage,
  commitPaths,
  isRepo,
  lastCommit,
  revertPlan,
  undoLast,
  MOLT_TRAILER,
  type RevertPlan,
} from "./git.js";
export {
  buildRepoMap,
  rankFiles,
  renderMap,
  symbolsIn,
  DEFAULT_MAP_TOKENS,
  type RepoMap,
} from "./repomap.js";
export {
  cmdCommit,
  cmdFor,
  cmdMap,
  cmdRead,
  cmdRevert,
  cmdUndo,
  parseDuration,
  parseToggle,
} from "./session-commands.js";
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
