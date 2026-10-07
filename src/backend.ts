/**
 * Shared shapes for subprocess backends (ACP agents such as Grok Build).
 *
 * These used to live in `claude-code.ts` because Claude Code was the first
 * non-HTTP backend. That backend is gone; the types stay here so ACP sessions
 * and the engine can share one event/session contract without importing a
 * deleted subscription path.
 */

/** An OpenAI-shaped tool definition, which is what molt holds internally. */
export type MoltTool = {
  readonly type: "function";
  readonly function: {
    readonly name: string;
    readonly description?: string;
    readonly parameters?: unknown;
  };
};

/** What molt does when the model calls one of its tools. */
export type ToolRunner<H> = (
  name: string,
  args: Record<string, unknown>,
  callId: string,
  /** Report progress while the call runs; ordered with everything else. */
  emit: (event: H) => void,
) => Promise<string>;

/**
 * What a subprocess backend tells the engine.
 *
 * Deliberately not `EngineEvent`: this module knows nothing about journals,
 * receipts or the bar. It carries the engine's own events through as `host`
 * instead — a tool call reports from inside molt's handler, and routing it
 * through the same queue is what keeps "molt is running grep" on screen
 * before the grep rather than after it.
 */
export type BackendEvent<H> =
  | { kind: "delta"; text: string }
  | {
      kind: "assistant";
      text: string;
      /** The calls this message made, with the ids the CLI gave them. */
      toolCalls: { id: string; name: string; args: Record<string, unknown> }[];
    }
  | { kind: "host"; event: H }
  | { kind: "info"; text: string }
  | {
      kind: "done";
      text: string;
      promptTokens: number;
      completionTokens: number;
      cachedTokens: number;
      /** Cumulative for the session. The engine takes the delta. */
      cumulativeCostUsd: number;
      error?: string;
    };

/**
 * The three methods the engine needs from a subprocess backend.
 *
 * Structural, so `AcpSession` satisfies it without the engine asking which
 * backend it is. A receipt, a bar and a ceiling cannot tell backends apart,
 * and neither should the loop.
 */
export interface BackendSession<H> {
  send(messages: readonly string[]): AsyncGenerator<BackendEvent<H>>;
  close(): Promise<void>;
  costSoFarUsd(): number;
  /**
   * The model that actually ran, when the backend can say so and it may differ
   * from the one requested. Receipts record this rather than the request.
   */
  ranModel?(): string | undefined;
}
