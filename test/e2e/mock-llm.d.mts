/** Types for test/e2e/mock-llm.mjs. */
export interface Mock {
  url: string;
  set(state: { mode?: "ok" | "limit"; until?: number; claim?: "five_hour" | "seven_day" }): void;
  requests(): string[];
  close(): Promise<void>;
}
export function startMock(): Promise<Mock>;
