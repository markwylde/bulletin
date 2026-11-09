import { ensureTemplateDatabase } from "@bulletin/test-utils/database";

const adminUrl = Bun.env.TEST_DATABASE_URL;

if (adminUrl !== undefined) {
  await ensureTemplateDatabase({ adminUrl });
}
