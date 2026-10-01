/**
 * Maat Agent's environment variables: `MAAT_*`, with the engine's older
 * `MOLT_*` names still read, so existing scripts and CI keep working.
 * `MAAT_` wins when both are set.
 */
export function env(name: string): string | undefined {
  return process.env[`MAAT_${name}`] ?? process.env[`MOLT_${name}`];
}
