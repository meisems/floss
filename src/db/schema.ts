import { MIGRATIONS } from "../generated/migrations.ts";
import { log } from "../lib/util.ts";

/**
 * Applies any of migrations/*.sql that the database hasn't seen yet, so a fresh (auto-provisioned)
 * D1 database works without pasting SQL into the console. Uses wrangler's own `d1_migrations`
 * table, so databases set up by hand via the console or `wrangler d1 migrations apply` are
 * recognised and never migrated twice. Runs once per isolate; afterwards it's a resolved promise.
 */
let ready: Promise<void> | null = null;

export function ensureSchema(d1: D1Database): Promise<void> {
  ready ??= migrate(d1).catch((err) => {
    ready = null; // retry on the next request instead of caching the failure
    throw err;
  });
  return ready;
}

async function applied(d1: D1Database): Promise<Set<string>> {
  const { results } = await d1.prepare("SELECT name FROM d1_migrations").all<{ name: string }>();
  return new Set(results.map((r) => r.name));
}

export async function migrate(d1: D1Database): Promise<void> {
  await d1
    .prepare(
      "CREATE TABLE IF NOT EXISTS d1_migrations (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT UNIQUE, applied_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP NOT NULL)",
    )
    .run();
  let done = await applied(d1);

  // A database set up by pasting 0001 into the console has the tables but no d1_migrations rows.
  if (!done.has(MIGRATIONS[0]!.name)) {
    const legacy = await d1.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'User'").first();
    if (legacy) {
      const hasReferrals = await d1.prepare("SELECT 1 FROM pragma_table_info('User') WHERE name = 'referralCode'").first();
      const adopt = MIGRATIONS.slice(0, hasReferrals ? 2 : 1).map((m) => m.name);
      await d1.batch(adopt.map((name) => d1.prepare("INSERT OR IGNORE INTO d1_migrations (name) VALUES (?)").bind(name)));
      done = await applied(d1);
    }
  }

  for (const m of MIGRATIONS) {
    if (done.has(m.name)) continue;
    try {
      // One batch = one transaction: the schema change and its bookkeeping row land together.
      await d1.batch([
        ...m.statements.map((s) => d1.prepare(s)),
        d1.prepare("INSERT INTO d1_migrations (name) VALUES (?)").bind(m.name),
      ]);
      log("info", "applied migration", { name: m.name });
    } catch (err) {
      // Another isolate may have applied it at the same moment; that's fine.
      if ((await applied(d1)).has(m.name)) continue;
      throw err;
    }
  }
}
