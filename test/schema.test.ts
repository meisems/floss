import { describe, expect, it } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { migrate } from "../src/db/schema.ts";
import { MIGRATIONS } from "../src/generated/migrations.ts";

/** Just enough of D1 (prepare/bind/run/all/first/batch) on top of node:sqlite. */
function fakeD1(db = new DatabaseSync(":memory:")) {
  const stmt = (sql: string, args: unknown[] = []) => ({
    sql,
    args,
    bind: (...a: unknown[]) => stmt(sql, a),
    run: async () => (db.prepare(sql).run(...args), { success: true }),
    all: async () => ({ results: db.prepare(sql).all(...args) }),
    first: async () => db.prepare(sql).get(...args) ?? null,
  });
  const d1 = {
    prepare: (sql: string) => stmt(sql),
    batch: async (list: Array<ReturnType<typeof stmt>>) => {
      db.exec("BEGIN");
      try {
        for (const s of list) db.prepare(s.sql).run(...s.args);
        db.exec("COMMIT");
      } catch (err) {
        db.exec("ROLLBACK");
        throw err;
      }
      return [];
    },
  };
  return { db, d1: d1 as unknown as D1Database };
}

const names = (db: DatabaseSync) => db.prepare("SELECT name FROM d1_migrations ORDER BY id").all().map((r) => r.name);
const columns = (db: DatabaseSync) => db.prepare("SELECT name FROM pragma_table_info('User')").all().map((r) => r.name);
const sqlOf = (i: number) => MIGRATIONS[i]!.statements.join(";\n") + ";";

describe("ensureSchema / migrate", () => {
  it("builds a fresh database and records every migration", async () => {
    const { db, d1 } = fakeD1();
    await migrate(d1);
    expect(names(db)).toEqual(MIGRATIONS.map((m) => m.name));
    expect(columns(db)).toContain("referralCode");
    expect(db.prepare("SELECT 1 FROM sqlite_master WHERE name = 'FeeLedger'").get()).toBeTruthy();
  });

  it("is a no-op the second time", async () => {
    const { db, d1 } = fakeD1();
    await migrate(d1);
    await migrate(d1);
    expect(names(db)).toEqual(MIGRATIONS.map((m) => m.name));
  });

  it("adopts a database set up by pasting both SQL files into the console", async () => {
    const { db, d1 } = fakeD1();
    db.exec(sqlOf(0));
    db.exec(sqlOf(1));
    db.prepare(`INSERT INTO "User" (id, telegramId, chatId, keySalt, updatedAt) VALUES ('u1','1','1','s',0)`).run();
    await migrate(d1);
    expect(names(db)).toEqual(["0001_init.sql", "0002_referrals_fees.sql"]);
    expect(db.prepare(`SELECT count(*) c FROM "User"`).get()!.c).toBe(1);
  });

  it("adopts 0001 only, then applies 0002", async () => {
    const { db, d1 } = fakeD1();
    db.exec(sqlOf(0));
    await migrate(d1);
    expect(names(db)).toEqual(["0001_init.sql", "0002_referrals_fees.sql"]);
    expect(columns(db)).toContain("referralOwedLamports");
  });
});
