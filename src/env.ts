import { secretValue } from "./secrets.js";

/**
 * Maat Agent's environment variables: `MAAT_*`, with the engine's older
 * `MOLT_*` names still read, so existing scripts and CI keep working.
 * `MAAT_` wins when both are set. A credential (`MAAT_API_KEY`) is found in
 * memory once `captureSecrets()` has taken it out of the environment
 * (src/secrets.ts).
 */
export function env(name: string): string | undefined {
  return secretValue(`MAAT_${name}`) ?? secretValue(`MOLT_${name}`);
}
