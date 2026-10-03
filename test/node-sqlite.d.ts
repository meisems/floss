// Minimal types for node:sqlite (the project doesn't depend on @types/node; tests run on Node 22+).
declare module "node:sqlite" {
  type Row = Record<string, any>;
  interface StatementSync {
    run(...params: unknown[]): unknown;
    get(...params: unknown[]): Row | undefined;
    all(...params: unknown[]): Row[];
  }
  export class DatabaseSync {
    constructor(path: string);
    exec(sql: string): void;
    prepare(sql: string): StatementSync;
  }
}
