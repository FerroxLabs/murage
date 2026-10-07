// The slice of D1 the relay uses. Structural, so the tests' node:sqlite
// adapter (test/d1.ts) and the real binding both satisfy it.
export interface DbStatement {
  bind(...values: unknown[]): DbStatement;
  first<T = Record<string, unknown>>(): Promise<T | null>;
  all<T = Record<string, unknown>>(): Promise<{ results: T[] }>;
  run(): Promise<{ meta: { changes: number } }>;
}
export interface Db {
  prepare(sql: string): DbStatement;
  batch(statements: DbStatement[]): Promise<Array<{ meta: { changes: number } }>>;
}
