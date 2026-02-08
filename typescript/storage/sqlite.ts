/** SQLite PaymentStorage using better-sqlite3. Amounts stored as TEXT for BigInt precision. */

import Database from "better-sqlite3";
import type {
  PaymentDirection,
  PaymentFilters,
  PaymentRecord,
  PaymentStorage,
} from "../types";

/** Row shape returned from SQLite queries */
interface PaymentRow {
  id: string;
  direction: string;
  counterparty: string;
  amount: string;
  network: string;
  tx_hash: string;
  resource: string;
  status: string;
  created_at: string;
  metadata: string;
}

export class SqlitePaymentStorage implements PaymentStorage {
  private db: Database.Database;

  constructor(dbPath: string) {
    this.db = new Database(dbPath);
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("foreign_keys = ON");
    this.initialize();
  }

  private initialize(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS x402_payments (
        id TEXT PRIMARY KEY,
        direction TEXT NOT NULL CHECK(direction IN ('outgoing', 'incoming')),
        counterparty TEXT NOT NULL,
        amount TEXT NOT NULL,
        network TEXT NOT NULL,
        tx_hash TEXT NOT NULL DEFAULT '',
        resource TEXT NOT NULL DEFAULT '',
        status TEXT NOT NULL DEFAULT 'pending',
        created_at TEXT NOT NULL,
        metadata TEXT NOT NULL DEFAULT '{}'
      );

      CREATE INDEX IF NOT EXISTS idx_x402_direction ON x402_payments(direction);
      CREATE INDEX IF NOT EXISTS idx_x402_created_at ON x402_payments(created_at);
      CREATE INDEX IF NOT EXISTS idx_x402_counterparty ON x402_payments(counterparty);
      CREATE INDEX IF NOT EXISTS idx_x402_status ON x402_payments(status);
    `);
  }

  async recordPayment(record: PaymentRecord): Promise<void> {
    const stmt = this.db.prepare(`
      INSERT INTO x402_payments (id, direction, counterparty, amount, network, tx_hash, resource, status, created_at, metadata)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    stmt.run(
      record.id,
      record.direction,
      record.counterparty,
      record.amount.toString(),
      record.network,
      record.txHash,
      record.resource,
      record.status,
      record.createdAt,
      JSON.stringify(record.metadata),
    );
  }

  async getTotal(
    direction: PaymentDirection,
    windowMs?: number,
    scope?: string,
  ): Promise<bigint> {
    let sql =
      "SELECT amount FROM x402_payments WHERE direction = ? AND status NOT IN ('failed', 'refunded')";
    const params: (string | number)[] = [direction];

    if (windowMs !== undefined) {
      const cutoff = new Date(Date.now() - windowMs).toISOString();
      sql += " AND created_at >= ?";
      params.push(cutoff);
    }

    if (scope) {
      sql += " AND counterparty = ?";
      params.push(scope);
    }

    const rows = this.db.prepare(sql).all(...params) as Array<{ amount: string }>;
    let total = 0n;
    for (const row of rows) {
      total += BigInt(row.amount);
    }
    return total;
  }

  async getRecords(filters?: PaymentFilters): Promise<PaymentRecord[]> {
    let sql = "SELECT * FROM x402_payments WHERE 1=1";
    const params: (string | number)[] = [];

    if (filters) {
      if (filters.direction) {
        sql += " AND direction = ?";
        params.push(filters.direction);
      }
      if (filters.counterparty) {
        sql += " AND LOWER(counterparty) = LOWER(?)";
        params.push(filters.counterparty);
      }
      if (filters.status) {
        sql += " AND status = ?";
        params.push(filters.status);
      }
      if (filters.network) {
        sql += " AND network = ?";
        params.push(filters.network);
      }
      if (filters.since) {
        sql += " AND created_at >= ?";
        params.push(filters.since);
      }
      if (filters.until) {
        sql += " AND created_at <= ?";
        params.push(filters.until);
      }
    }

    sql += " ORDER BY created_at DESC";

    if (filters?.limit !== undefined) {
      sql += " LIMIT ?";
      params.push(filters.limit);
    }
    if (filters?.offset !== undefined) {
      sql += " OFFSET ?";
      params.push(filters.offset);
    }

    const rows = this.db.prepare(sql).all(...params) as PaymentRow[];
    return rows.map((row) => this.rowToRecord(row));
  }

  async getCount(
    direction: PaymentDirection,
    windowMs?: number,
  ): Promise<number> {
    let sql =
      "SELECT COUNT(*) as cnt FROM x402_payments WHERE direction = ? AND status NOT IN ('failed', 'refunded')";
    const params: (string | number)[] = [direction];

    if (windowMs !== undefined) {
      const cutoff = new Date(Date.now() - windowMs).toISOString();
      sql += " AND created_at >= ?";
      params.push(cutoff);
    }

    const row = this.db.prepare(sql).get(...params) as { cnt: number };
    return row.cnt;
  }

  async clear(): Promise<void> {
    this.db.exec("DELETE FROM x402_payments");
  }

  close(): void {
    this.db.close();
  }

  private rowToRecord(row: PaymentRow): PaymentRecord {
    let metadata: Record<string, string> = {};
    try {
      metadata = JSON.parse(row.metadata) as Record<string, string>;
    } catch (_metadataParseError) {
      // Non-critical: metadata is optional display data
    }

    return {
      id: row.id,
      direction: row.direction as PaymentDirection,
      counterparty: row.counterparty,
      amount: BigInt(row.amount),
      network: row.network,
      txHash: row.tx_hash,
      resource: row.resource,
      status: row.status as PaymentRecord["status"],
      createdAt: row.created_at,
      metadata,
    };
  }
}
