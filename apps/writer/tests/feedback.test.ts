// OW-02: the flash a mutation leaves for the next page, the names in flash and error toasts, and
// the code → human text table that api() applies (both modules are DOM-free).
import { afterEach, describe, expect, it, vi } from "vitest";

import { ApiError, api, ERROR_TEXT, errorText } from "../src/client/api.ts";
import {
  decodeFlash,
  dropFlash,
  encodeFlash,
  restoreFlash,
  retryFlash,
  revisionName,
  trashFlash,
} from "../src/client/feedback.ts";

const NETWORK = {
  cause: "The writer didn't answer.",
  next: "Check your tailnet connection, then try again.",
};
const FALLBACK = { cause: "The writer couldn't do that.", next: "Status may show more." };
const INTERNAL = { cause: "The writer hit an error.", next: "Status may show more." };

describe("flash", () => {
  it("round-trips and drops anything that isn't a flash", () => {
    for (const input of [
      { text: "Renamed" },
      { text: "Moved “X” to Trash", detail: "Its 1 public link is paused.", id: "col_1" },
    ])
      expect(decodeFlash(encodeFlash(input))).toEqual(input);
    expect(decodeFlash(null)).toBeNull();
    expect(decodeFlash("{")).toBeNull();
    expect(decodeFlash('{"x":1}')).toBeNull();
    expect(decodeFlash("null")).toBeNull();
    expect(decodeFlash('{"text":""}')).toBeNull();
  });

  it("says what Move to Trash did to the links", () => {
    expect(trashFlash("Q4 onboarding revamp", 1)).toEqual({
      text: "Moved “Q4 onboarding revamp” to Trash",
      detail: "Its 1 public link is paused, not revoked. Restore asks whether to turn it back on.",
    });
    expect(trashFlash("Q4 onboarding revamp", 2)).toEqual({
      text: "Moved “Q4 onboarding revamp” to Trash",
      detail:
        "Its 2 public links are paused, not revoked. Restore asks whether to turn them back on.",
    });
    expect(trashFlash("Q4 onboarding revamp", 0)).toEqual({
      text: "Moved “Q4 onboarding revamp” to Trash",
    });
  });

  it("names revisions and collections", () => {
    expect(retryFlash(1, 6, "Postgres 17 upgrade runbook")).toBe(
      "Retrying #6 of “Postgres 17 upgrade runbook”",
    );
    expect(retryFlash(1, 6, null)).toBe("Retrying #6");
    expect(retryFlash(2, null, null)).toBe("Retrying 2 revisions");
    expect(dropFlash([6, 7], "X")).toBe("Dropped #6, #7 from “X”");
    expect(dropFlash([6], null)).toBe("Dropped #6");
    expect(revisionName(null, null)).toBe("the revision");
    expect(revisionName(null, "X")).toBe("the revision");
    expect(restoreFlash("X", 0)).toBe("Restored “X”");
    expect(restoreFlash("X", 2)).toBe("Restored “X” and revoked its 2 public links");
  });
});

describe("errorText", () => {
  it("maps codes to a cause and a next step", () => {
    expect(errorText("network", null, "Failed to fetch")).toEqual(NETWORK);
    expect(errorText("collection_deleted", 409, "Collection is deleted")).toEqual({
      cause: "This collection is in Trash.",
      next: "Restore it from Trash first.",
    });
  });

  it("shows validation and conflict messages as the writer wrote them", () => {
    expect(errorText("validation_failed", 400, "Expiry must be in the future")).toEqual({
      cause: "Expiry must be in the future.",
      next: "",
    });
    expect(errorText("conflict", 409, "Sharing is not configured")).toEqual({
      cause: "Sharing is not configured.",
      next: "",
    });
    expect(errorText("conflict", 409, "Share link is revoked.")).toEqual({
      cause: "Share link is revoked.",
      next: "",
    });
    // No message: the generic rules.
    expect(errorText("conflict", 409, "Request failed (409)")).toEqual(FALLBACK);
    expect(errorText("validation_failed", 400, "")).toEqual(FALLBACK);
    expect(Object.hasOwn(ERROR_TEXT, "conflict")).toBe(false);
    expect(Object.hasOwn(ERROR_TEXT, "validation_failed")).toBe(false);
  });

  it("falls back by status for unknown codes", () => {
    expect(errorText("something_new", 503, "Down")).toEqual(INTERNAL);
    expect(errorText(null, 500, "Request failed (500)")).toEqual(INTERNAL);
    expect(errorText("something_new", 418, "Teapot")).toEqual(FALLBACK);
    expect(errorText("toString", 400, "x")).toEqual(FALLBACK);
    // OW-14 adds the purge row.
    expect(Object.hasOwn(ERROR_TEXT, "collection_purged")).toBe(false);
  });
});

describe("api", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("turns a rejected fetch into a network ApiError", async () => {
    vi.stubGlobal("fetch", () => Promise.reject(new TypeError("Failed to fetch")));
    const error: unknown = await api("/api/queue/x/retry", "POST").catch((cause: unknown) => cause);
    expect(error).toBeInstanceOf(ApiError);
    if (!(error instanceof ApiError)) return;
    expect(error.code).toBe("network");
    expect(error.status).toBeNull();
    expect(error.raw).toBe("Failed to fetch");
    expect(error.message).toBe(`${NETWORK.cause} ${NETWORK.next}`);
  });

  it("keeps the writer's own words for a conflict, with no reload advice", async () => {
    vi.stubGlobal("fetch", () =>
      Promise.resolve(
        Response.json(
          { error: { code: "conflict", message: "Sharing is not configured" } },
          { status: 409 },
        ),
      ),
    );
    const error: unknown = await api("/api/collections/x/share-links", "POST", {}).catch(
      (cause: unknown) => cause,
    );
    expect(error).toBeInstanceOf(ApiError);
    if (!(error instanceof ApiError)) return;
    expect(error.code).toBe("conflict");
    expect(error.status).toBe(409);
    expect(error.raw).toBe("Sharing is not configured");
    expect(error.message).toBe("Sharing is not configured.");
  });

  it("synthesizes the raw text when the body has none", async () => {
    vi.stubGlobal("fetch", () => Promise.resolve(new Response("oops", { status: 502 })));
    const error: unknown = await api("/api/x").catch((cause: unknown) => cause);
    expect(error).toBeInstanceOf(ApiError);
    if (!(error instanceof ApiError)) return;
    expect(error.code).toBeNull();
    expect(error.raw).toBe("Request failed (502)");
    expect(error.message).toBe(`${INTERNAL.cause} ${INTERNAL.next}`);
  });
});
