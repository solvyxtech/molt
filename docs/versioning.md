# Versioning

Desktop and CLI share one engine and one semver.

- Root `package.json` (`molt-desktop`, private) is the source of truth for the version string.
- `molt --version` reads that field from the package that shipped the binary.
- Publishable CLI package `@solvyx/molt` is staged by `npm run pack:cli`, which copies the same version into `out-cli/package.json`.
- GitHub Release tags (`v0.2.0`, `v0.3.0`, …) name both surfaces: desktop installers on the release, CLI via `npm i -g @solvyx/molt` at that version.

Do not start an independent CLI major while the engine is the same. A CLI-only packaging fix can be a patch (`0.2.1`) with clear notes.
