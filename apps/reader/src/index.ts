import { connect } from "@tursodatabase/serverless";
import { AwsClient } from "aws4fetch";

import { createReaderApp, type ReaderBlob, type ReaderDb, type ReaderEnv } from "./app.ts";
import { blobUrl, probeUrl } from "./bucket-url.ts";

declare const caches: { default: Cache };

function database(env: ReaderEnv): ReaderDb {
  const connection = connect({ url: env.TURSO_DATABASE_URL, authToken: env.TURSO_READONLY_TOKEN });
  return {
    async all<T>(sql: string, args: (string | number)[] = []): Promise<T[]> {
      const rows: unknown = await connection.all(sql, args);
      if (!Array.isArray(rows)) throw new Error("Invalid Turso result");
      const values: unknown[] = rows;
      // The serverless client exposes rows as any; query call sites own their row shape.
      // oxlint-disable-next-line typescript/no-unsafe-type-assertion
      return values.map((value) => value as T);
    },
  };
}

function blobStore(env: ReaderEnv): ReaderBlob {
  const signer = new AwsClient({
    accessKeyId: env.R2_READER_ACCESS_KEY_ID,
    secretAccessKey: env.R2_READER_SECRET_ACCESS_KEY,
    service: "s3",
    region: env.WAYPOINT_S3_REGION || "auto",
  });
  return {
    probe(): Promise<Response> {
      return signer.fetch(probeUrl(env));
    },
    fetch(hash: string): Promise<Response> {
      const url = blobUrl(env, hash);
      if (!url) return Promise.resolve(new Response(null, { status: 404 }));
      return signer.fetch(url);
    },
  };
}

export default createReaderApp({ db: database, blob: blobStore, cache: caches.default });
