export type WaypointErrorCode =
  | "forbidden"
  | "unsupported_media_type"
  | "conflict"
  | "internal_error"
  | "validation_failed"
  | "path_invalid"
  | "path_case_conflict"
  | "head_path_missing"
  | "head_path_ambiguous"
  | "blob_missing"
  | "blob_hash_mismatch"
  | "bucket_corrupt"
  | "bucket_unavailable"
  | "blob_too_large"
  | "revision_too_large"
  | "clock_skew"
  | "stale_id"
  | "id_before_parent"
  | "revision_conflict"
  | "collection_not_found"
  | "collection_deleted"
  | "collection_purged"
  | "parent_not_found"
  | "parent_failed"
  | "not_found";

export const ERROR_STATUS: Record<WaypointErrorCode, number> = {
  forbidden: 403,
  unsupported_media_type: 415,
  conflict: 409,
  internal_error: 500,
  validation_failed: 400,
  path_invalid: 400,
  path_case_conflict: 400,
  head_path_missing: 400,
  head_path_ambiguous: 400,
  blob_missing: 422,
  blob_hash_mismatch: 422,
  bucket_corrupt: 502,
  bucket_unavailable: 503,
  blob_too_large: 413,
  revision_too_large: 413,
  clock_skew: 400,
  stale_id: 400,
  id_before_parent: 400,
  revision_conflict: 409,
  collection_not_found: 404,
  collection_deleted: 410,
  collection_purged: 410,
  parent_not_found: 422,
  parent_failed: 422,
  not_found: 404,
};

export class WaypointError extends Error {
  readonly httpStatus: number;
  constructor(
    readonly code: WaypointErrorCode,
    message: string,
    readonly details: Record<string, unknown> = {},
  ) {
    super(message);
    this.name = "WaypointError";
    this.httpStatus = ERROR_STATUS[code];
  }
  toBody(): {
    error: {
      code: WaypointErrorCode;
      message: string;
      details: Record<string, unknown>;
    };
  } {
    return {
      error: { code: this.code, message: this.message, details: this.details },
    };
  }
}

export interface WaypointErrorLike {
  name: "WaypointError";
  code: WaypointErrorCode;
  message: string;
  details: Record<string, unknown>;
  httpStatus: number;
  toBody(): {
    error: { code: WaypointErrorCode; message: string; details: Record<string, unknown> };
  };
}

export function isWaypointError(value: unknown): value is WaypointErrorLike {
  if (typeof value !== "object" || value === null) return false;
  return (
    "name" in value &&
    value.name === "WaypointError" &&
    "code" in value &&
    typeof value.code === "string" &&
    Object.hasOwn(ERROR_STATUS, value.code) &&
    "message" in value &&
    typeof value.message === "string" &&
    "details" in value &&
    typeof value.details === "object" &&
    value.details !== null &&
    "httpStatus" in value &&
    typeof value.httpStatus === "number" &&
    "toBody" in value &&
    typeof value.toBody === "function"
  );
}
