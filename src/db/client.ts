import { PrismaD1 } from "@prisma/adapter-d1";
import { PrismaClient } from "../generated/prisma/client.ts";

export type Db = PrismaClient;

/**
 * One PrismaClient per D1 binding per isolate. Building the client initialises the WASM query
 * compiler, so reusing it across requests on a warm isolate is noticeably cheaper.
 */
const clients = new WeakMap<D1Database, PrismaClient>();

export function getDb(d1: D1Database): Db {
  let client = clients.get(d1);
  if (!client) {
    client = new PrismaClient({ adapter: new PrismaD1(d1) });
    clients.set(d1, client);
  }
  return client;
}
