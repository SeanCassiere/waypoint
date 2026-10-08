import { connect } from "@tursodatabase/serverless";
import { AwsClient } from "aws4fetch";

import { createReaderApp, type ReaderBlob, type ReaderDb, type ReaderEnv } from "./app.ts";

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
    region: "auto",
  });
  return {
    probe(): Promise<Response> {
      return signer.fetch(
        `https://${env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com/${env.R2_BUCKET}?list-type=2&max-keys=0`,
      );
    },
    fetch(hash: string): Promise<Response> {
      if (!/^sha256:[0-9a-f]{64}$/.test(hash))
        return Promise.resolve(new Response(null, { status: 404 }));
      return signer.fetch(
        `https://${env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com/${env.R2_BUCKET}/blobs/sha256/${hash.slice(7)}`,
      );
    },
  };
}

export default createReaderApp({ db: database, blob: blobStore, cache: caches.default });
