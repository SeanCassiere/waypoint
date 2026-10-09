export interface ErrorText {
  cause: string;
  next: string;
}
/** What went wrong and what to do next, by error code (OW-02). validation_failed and conflict
 *  have no row: their messages are written for people, so they're shown as the writer wrote them. */
export const ERROR_TEXT: Record<string, ErrorText> = {
  network: {
    cause: "The writer didn't answer.",
    next: "Check your tailnet connection, then try again.",
  },
  not_found: {
    cause: "It no longer exists on this writer.",
    next: "Reload the page to see the current state.",
  },
  collection_not_found: {
    cause: "It no longer exists on this writer.",
    next: "Reload the page to see the current state.",
  },
  collection_deleted: {
    cause: "This collection is in Trash.",
    next: "Restore it from Trash first.",
  },
  collection_purged: { cause: "This collection is being purged and can't be restored.", next: "" },
  forbidden: { cause: "The writer refused the request.", next: "Reload the page, then try again." },
  bucket_unavailable: {
    cause: "The bucket can't be reached right now.",
    next: "Status shows when it's back.",
  },
  internal_error: { cause: "The writer hit an error.", next: "Status may show more." },
};
const FALLBACK: ErrorText = {
  cause: "The writer couldn't do that.",
  next: "Status may show more.",
};
/** Codes whose message is shown as written. */
const OWN_WORDS = new Set(["validation_failed", "conflict"]);
const SYNTHESIZED = /^Request failed \(\d+\)$/;

export function errorText(code: string | null, status: number | null, raw: string): ErrorText {
  const message = raw.trim();
  if (code && OWN_WORDS.has(code) && message && !SYNTHESIZED.test(message))
    return { cause: /[.!?]$/.test(message) ? message : `${message}.`, next: "" };
  if (code && Object.hasOwn(ERROR_TEXT, code)) return ERROR_TEXT[code] ?? FALLBACK;
  if (status !== null && status >= 500) return ERROR_TEXT.internal_error ?? FALLBACK;
  return FALLBACK;
}

/** Every failed request. `message` is the human text (cause and next step); `raw` is what the
 *  writer (or fetch) said, kept for the error toast. */
export class ApiError extends Error {
  readonly code: string | null;
  readonly status: number | null;
  readonly raw: string;
  constructor(code: string | null, status: number | null, raw: string) {
    const text = errorText(code, status, raw);
    super(`${text.cause} ${text.next}`.trim());
    this.name = "ApiError";
    this.code = code;
    this.status = status;
    this.raw = raw;
  }
}

async function body(response: Response): Promise<unknown> {
  try {
    const value: unknown = await response.json();
    return value;
  } catch {
    return null;
  }
}
/** Same-origin JSON request. Mutations always send Content-Type: application/json (CSRF rule). */
export async function api(url: string, method = "GET", payload?: object): Promise<unknown> {
  let response: Response;
  try {
    response = await fetch(url, {
      method,
      credentials: "same-origin",
      ...(method === "GET"
        ? {}
        : { headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload ?? {}) }),
    });
  } catch (cause) {
    // fetch rejects (a TypeError such as "Failed to fetch") only when no response arrived.
    throw new ApiError("network", null, cause instanceof Error ? cause.message : String(cause));
  }
  const value = await body(response);
  if (!response.ok) {
    const error = field(value, "error");
    const code = field(error, "code");
    const message = field(error, "message");
    throw new ApiError(
      typeof code === "string" ? code : null,
      response.status,
      typeof message === "string" && message ? message : `Request failed (${response.status})`,
    );
  }
  return value;
}
export function field(value: unknown, key: string): unknown {
  if (!value || typeof value !== "object" || !(key in value)) return undefined;
  const found: unknown = Reflect.get(value, key);
  return found;
}
