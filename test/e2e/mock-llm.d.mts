/** Types for test/e2e/mock-llm.mjs. */
export interface MockRequest {
  method: string;
  path: string;
  /** Answered with the agent's usage-limit response. */
  limited: boolean;
  /** The request body. */
  body: string;
  /** The text of each user message in the request, in order. */
  user: string[];
  /** Anthropic Messages: Claude Code's session id, from metadata.user_id. */
  session?: string;
  /** Anthropic Messages: the text of the last user message (its last 4,000 characters). */
  prompt?: string;
}
export interface Mock {
  url: string;
  set(state: {
    mode?: "ok" | "limit";
    until?: number;
    claim?: "five_hour" | "seven_day";
    profile?: "" | "copilot" | "xai-free" | "xai-402";
    reply?: string;
    /** Refuses unconditionally, regardless of `until`, until cleared with `limitForce: false`. */
    limitForce?: boolean;
    /** Answer model requests after this many ms (default 0). */
    think?: number;
  }): void;
  /** "METHOD /path" of every request, in order. */
  requests(): string[];
  log(): MockRequest[];
  close(): Promise<void>;
}
export function startMock(): Promise<Mock>;
