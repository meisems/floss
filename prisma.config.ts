import { defineConfig } from "prisma/config";

// Cloudflare's build only runs `prisma generate`. The datasource URL below is a local SQLite
// file used solely to produce migrations/0001_init.sql; production data lives in D1 and the
// schema is applied by pasting that SQL into the D1 Console.
export default defineConfig({
  schema: "prisma/schema.prisma",
  datasource: { url: "file:./prisma/dev.db" },
});
