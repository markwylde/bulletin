import { SQL } from "bun";
import { createS3Handler } from "./app.ts";
import { createPostgresStore } from "./postgres.ts";

const port = Number(Bun.env.PORT ?? 4001);
const databaseUrl = Bun.env.DATABASE_URL ?? "postgres://bulletin:bulletin@localhost:5432/bulletin";
const bucket = Bun.env.S3_BUCKET ?? "bulletin";
const basePath = Bun.env.MOCK_BASE_PATH ?? "";

const sql = new SQL(databaseUrl);
// Like production, previous versions expire 35 days after they stop being current (ADR 0020).
const noncurrentDays = Number(Bun.env.S3_NONCURRENT_VERSION_DAYS ?? "35");
const store = await createPostgresStore(sql, {
  noncurrentDays: Number.isFinite(noncurrentDays) && noncurrentDays > 0 ? noncurrentDays : 35,
});
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
