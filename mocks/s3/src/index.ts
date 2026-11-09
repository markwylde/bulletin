import { SQL } from "bun";
import { createS3Handler } from "./app.ts";
import { createPostgresStore } from "./postgres.ts";

const port = Number(Bun.env.PORT ?? 4001);
const databaseUrl = Bun.env.DATABASE_URL ?? "postgres://bulletin:bulletin@localhost:5432/bulletin";
const bucket = Bun.env.S3_BUCKET ?? "bulletin";
const basePath = Bun.env.MOCK_BASE_PATH ?? "";

const sql = new SQL(databaseUrl);
const store = await createPostgresStore(sql);
const handler = createS3Handler({
  store,
  bucket,
  basePath,
  credentials: {
    accessKeyId: Bun.env.S3_ACCESS_KEY_ID ?? "bulletin",
    secretAccessKey: Bun.env.S3_SECRET_ACCESS_KEY ?? "bulletin-secret",
    region: Bun.env.S3_REGION ?? "us-east-1",
  },
});

Bun.serve({ port, fetch: handler });

console.log(`mock-s3 listening on http://localhost:${port}${basePath}`);
