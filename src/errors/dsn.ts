/**
 * Parsing a Sentry DSN so the ingest URL and project id are derived at runtime, not hardcoded
 * twice: rotating the DSN later is a one-line change (plan: see AGENTS.md task notes).
 *
 * A DSN looks like `https://<public_key>@<host>/<project_id>` (optionally
 * `https://<public_key>@<host>/<path>/<project_id>` for a self-hosted ingest path prefix).
 */
export interface Dsn {
  publicKey: string;
  host: string;
  projectId: string;
  /** Where to POST envelopes: `https://<host>/api/<project_id>/envelope/`. */
  envelopeUrl: string;
}

/**
 * The owner's own Sentry project for Agent Rewake's opt-in error reports. Public by design: a DSN
 * identifies where events go, not a secret (Sentry's own docs: a DSN is safe to ship in a client).
 */
export const DEFAULT_DSN =
  "https://b7c2ddf4d39fb630623f79338076b83d@o1305163.ingest.us.sentry.io/4512221393715200";

/** Parse a DSN string, or undefined if it isn't one Rewake can use. A bad DSN just means: off. */
export function parseDsn(dsn: string): Dsn | undefined {
  let url: URL;
  try {
    url = new URL(dsn);
  } catch {
    return undefined;
  }
  const publicKey = url.username;
  const host = url.host;
  const projectId = url.pathname.split("/").filter(Boolean).pop();
  if (!publicKey || !host || !projectId || !/^\d+$/.test(projectId)) return undefined;
  return {
    publicKey,
    host,
    projectId,
    envelopeUrl: `https://${host}/api/${projectId}/envelope/`,
  };
}
