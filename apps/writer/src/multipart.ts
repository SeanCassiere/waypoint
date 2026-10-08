import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";

import { DEFAULT_LIMITS, validatePath, WaypointError, type RequestFile } from "@waypoint/core";
import busboy from "busboy";
import { z } from "zod";

import type { BlobStore } from "./blob-store.ts";

type Limits = { maxFiles: number; maxRevisionBytes: number };
type ActiveFile = { stream: Readable; meter: Transform };
function multipartError(error: unknown): Error {
  if (error instanceof WaypointError) return error;
  if (error instanceof Error && !/Unexpected end of form|aborted|ECONNRESET/i.test(error.message))
    return error;
  return new WaypointError("validation_failed", "Malformed multipart body");
}

export async function parseMultipart(
  request: Request,
  blobs: BlobStore,
  limits: Limits = {
    maxFiles: DEFAULT_LIMITS.maxFiles,
    maxRevisionBytes: DEFAULT_LIMITS.maxRevisionBytes,
  },
  validateMeta?: (meta: Record<string, unknown>) => Promise<void>,
): Promise<Record<string, unknown>> {
  const body = request.body;
  if (!body) throw new WaypointError("validation_failed", "Multipart body required");
  let parser: ReturnType<typeof busboy>;
  try {
    parser = busboy({
      headers: { "content-type": request.headers.get("content-type") ?? "" },
      limits: {
        fieldSize: 1024 * 1024,
        fields: 2,
        files: limits.maxFiles + 1,
        fileSize: blobs.maxBlobBytes + 1,
      },
    });
  } catch {
    throw new WaypointError("validation_failed", "Invalid multipart body");
  }

  let total = 0;
  let fileBytes = 0;
  let fileCount = 0;
  let first = true;
  let meta: Record<string, unknown> | undefined;
  let validation: Promise<void> = Promise.resolve();
  let failure: Error | undefined;
  const files: RequestFile[] = [];
  const tasks: Promise<void>[] = [];
  const active = new Set<ActiveFile>();
  const fail = (error: unknown): void => {
    if (failure) return;
    failure = multipartError(error);
    for (const part of active) {
      part.meter.destroy(failure);
      part.stream.resume();
    }
  };
  const limiter = new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      total += chunk.byteLength;
      if (total > limits.maxRevisionBytes + 8 * 1024 * 1024)
        callback(new WaypointError("revision_too_large", "Multipart request exceeds limit"));
      else callback(null, chunk);
    },
  });

  parser.on("field", (name, value, info) => {
    if (first) {
      first = false;
      if (name !== "meta" || info.valueTruncated) {
        fail(new WaypointError("validation_failed", "meta must be the first multipart part"));
        return;
      }
      try {
        const parsed: unknown = JSON.parse(value);
        const checked = z.record(z.string(), z.unknown()).safeParse(parsed);
        if (!checked.success) throw new Error("Invalid meta");
        meta = checked.data;
        validation = Promise.resolve()
          .then(() => validateMeta?.(checked.data))
          .then(() => undefined)
          .catch(fail);
      } catch {
        fail(new WaypointError("validation_failed", "Invalid meta JSON"));
      }
      return;
    }
    fail(
      new WaypointError(
        "validation_failed",
        name.startsWith("file:")
          ? "File part requires a filename"
          : "Only one meta field is allowed",
      ),
    );
  });

  parser.on("file", (name, stream, info) => {
    // Busboy destroys FileStreams on malformed or aborted requests.
    let meter: Transform | undefined;
    stream.on("error", (error: Error) => {
      fail(error);
      meter?.destroy(error);
    });
    if (failure) {
      stream.resume();
      return;
    }
    if (first || !meta) {
      fail(new WaypointError("validation_failed", "meta must be the first multipart part"));
      stream.resume();
      return;
    }
    if (!name.startsWith("file:")) {
      fail(new WaypointError("validation_failed", "Invalid file field name"));
      stream.resume();
      return;
    }
    let path: string;
    try {
      path = validatePath(name.slice(5));
    } catch (error) {
      fail(error);
      stream.resume();
      return;
    }
    fileCount++;
    if (fileCount > limits.maxFiles) {
      fail(new WaypointError("revision_too_large", "Too many files"));
      stream.resume();
      return;
    }
    meter = new Transform({
      transform(chunk: Buffer, _encoding, callback) {
        fileBytes += chunk.byteLength;
        if (fileBytes > limits.maxRevisionBytes)
          failure ??= new WaypointError("revision_too_large", "Multipart revision exceeds limit");
        callback(null, chunk);
      },
    });
    const fileMeter = meter;
    // A destroyed meter can emit before BlobStore's pipeline attaches listeners.
    fileMeter.on("error", () => stream.resume());
    stream.on("limit", () =>
      fail(new WaypointError("blob_too_large", "Blob exceeds configured limit")),
    );
    const part: ActiveFile = { stream, meter: fileMeter };
    active.add(part);
    const mime =
      info.mimeType && info.mimeType !== "application/octet-stream" ? info.mimeType : undefined;
    const task = (async () => {
      await validation;
      if (failure) {
        stream.resume();
        return;
      }
      // pipeline forwards FileStream errors to the meter, which settles put().
      const forwarded = pipeline(stream, fileMeter);
      const put = blobs.put(fileMeter);
      const [sourceResult, blobResult] = await Promise.allSettled([forwarded, put]);
      if (sourceResult.status === "rejected") fail(sourceResult.reason);
      if (blobResult.status === "rejected") fail(blobResult.reason);
      if (sourceResult.status === "fulfilled" && blobResult.status === "fulfilled" && !failure)
        files.push({ path, hash: blobResult.value.hash, ...(mime ? { mime } : {}) });
    })()
      .catch(fail)
      .finally(() => {
        active.delete(part);
      });
    tasks.push(task);
  });
  parser.on("filesLimit", () => fail(new WaypointError("revision_too_large", "Too many files")));
  parser.on("fieldsLimit", () =>
    fail(new WaypointError("validation_failed", "Too many multipart fields")),
  );
  parser.on("error", fail);

  try {
    await pipeline(Readable.fromWeb(body), limiter, parser);
    await validation;
    await Promise.all(tasks);
  } catch (error) {
    fail(error);
    // The outer request failed: stop every file source so no put can wait on
    // a busboy stream that will never receive another chunk or a final part.
    for (const part of active) {
      part.stream.destroy(failure);
      part.meter.destroy(failure);
    }
    await Promise.allSettled(tasks);
  }
  if (failure) throw failure;
  if (!meta) throw new WaypointError("validation_failed", "Multipart meta JSON required");
  return { ...meta, files };
}
