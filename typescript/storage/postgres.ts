/** PostgreSQL PaymentStorage for multi-tenant Eliza Cloud deployments. Amounts stored as TEXT for BigInt precision. */

import pg from "pg";
import type {
  PaymentDirection,
  PaymentFilters,
  PaymentRecord,
  PaymentStorage,
} from "../types";

const { Pool } = pg;

/** Row shape returned from Postgres queries */
interface PaymentRow {
  id: string;
  agent_id: string;
  direction: string;
  counterparty: string;
  amount: string;
  network: string;
  tx_hash: string;
  resource: string;
  status: string;
  created_at: string;
  metadata: Record<string, string>;
}

export class PostgresPaymentStorage implements PaymentStorage {
  private pool: pg.Pool;
  private agentId: string;
  private initialized: Promise<void>;

  constructor(connectionString: string, agentId: string) {
    this.pool = new Pool({ connectionString });
    this.agentId = agentId;
    this.initialized = this.initialize();
  }

  private async initialize(): Promise<void> {
    const client = await this.pool.connect();
    try {
      await client.query(`
        CREATE TABLE IF NOT EXISTS x402_payments (
          id TEXT PRIMARY KEY,
          agent_id TEXT NOT NULL,
          direction VARCHAR NOT NULL CHECK(direction IN ('outgoing', 'incoming')),
          counterparty TEXT NOT NULL,
          amount TEXT NOT NULL,
          network TEXT NOT NULL,
          tx_hash TEXT NOT NULL DEFAULT '',
          resource TEXT NOT NULL DEFAULT '',
          status TEXT NOT NULL DEFAULT 'pending',
          created_at TEXT NOT NULL,
          metadata JSONB NOT NULL DEFAULT '{}'
        );
        CREATE INDEX IF NOT EXISTS idx_x402_agent ON x402_payments(agent_id);
        CREATE INDEX IF NOT EXISTS idx_x402_direction ON x402_payments(agent_id, direction, created_at);
      `);
    } finally {
      client.release();
    }
  }

  /** Ensure the table is created before any operation */
  private async ready(): Promise<void> {
    await this.initialized;
  }

  async recordPayment(record: PaymentRecord): Promise<void> {
    await this.ready();
    await this.pool.query(
      `INSERT INTO x402_payments (id, agent_id, direction, counterparty, amount, network, tx_hash, resource, status, created_at, metadata)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
      [
        record.id,
        this.agentId,
        record.direction,
        record.counterparty,
        record.amount.toString(),
        record.network,
        record.txHash,
        record.resource,
        record.status,
        record.createdAt,
        JSON.stringify(record.metadata),
      ],
    );
  }

  async getTotal(
    direction: PaymentDirection,
    windowMs?: number,
    scope?: string,
  ): Promise<bigint> {
    await this.ready();

    let sql =
      "SELECT amount FROM x402_payments WHERE agent_id = $1 AND direction = $2 AND status NOT IN ('failed', 'refunded')";
    const params: (string | number)[] = [this.agentId, direction];
    let paramIdx = 3;

    if (windowMs !== undefined) {
      const cutoff = new Date(Date.now() - windowMs).toISOString();
      sql += ` AND created_at >= $${paramIdx}`;
      params.push(cutoff);
      paramIdx++;
    }

    if (scope) {
      sql += ` AND counterparty = $${paramIdx}`;
      params.push(scope);
      paramIdx++;
    }

    const result = await this.pool.query<{ amount: string }>(sql, params);
    let total = 0n;
    for (const row of result.rows) {
      total += BigInt(row.amount);
    }
    return total;
  }

  async getRecords(filters?: PaymentFilters): Promise<PaymentRecord[]> {
    await this.ready();

    let sql = "SELECT * FROM x402_payments WHERE agent_id = $1";
    const params: (string | number)[] = [this.agentId];
    let paramIdx = 2;

    if (filters) {
      if (filters.direction) {
        sql += ` AND direction = $${paramIdx}`;
        params.push(filters.direction);
        paramIdx++;
      }
      if (filters.counterparty) {
        sql += ` AND LOWER(counterparty) = LOWER($${paramIdx})`;
        params.push(filters.counterparty);
        paramIdx++;
      }
      if (filters.status) {
        sql += ` AND status = $${paramIdx}`;
        params.push(filters.status);
        paramIdx++;
      }
      if (filters.network) {
        sql += ` AND network = $${paramIdx}`;
        params.push(filters.network);
        paramIdx++;
      }
      if (filters.since) {
        sql += ` AND created_at >= $${paramIdx}`;
        params.push(filters.since);
        paramIdx++;
      }
      if (filters.until) {
        sql += ` AND created_at <= $${paramIdx}`;
        params.push(filters.until);
        paramIdx++;
      }
    }

    sql += " ORDER BY created_at DESC";

    if (filters?.limit !== undefined) {
      sql += ` LIMIT $${paramIdx}`;
      params.push(filters.limit);
      paramIdx++;
    }
    if (filters?.offset !== undefined) {
      sql += ` OFFSET $${paramIdx}`;
      params.push(filters.offset);
      paramIdx++;
    }

    const result = await this.pool.query<PaymentRow>(sql, params);
    return result.rows.map((row) => this.rowToRecord(row));
  }

  async getCount(
    direction: PaymentDirection,
    windowMs?: number,
  ): Promise<number> {
    await this.ready();

    let sql =
      "SELECT COUNT(*) as cnt FROM x402_payments WHERE agent_id = $1 AND direction = $2 AND status NOT IN ('failed', 'refunded')";
    const params: (string | number)[] = [this.agentId, direction];
    let paramIdx = 3;

    if (windowMs !== undefined) {
      const cutoff = new Date(Date.now() - windowMs).toISOString();
      sql += ` AND created_at >= $${paramIdx}`;
      params.push(cutoff);
      paramIdx++;
    }

    const result = await this.pool.query<{ cnt: string }>(sql, params);
    return parseInt(result.rows[0].cnt, 10);
  }

  async clear(): Promise<void> {
    await this.ready();
    await this.pool.query("DELETE FROM x402_payments WHERE agent_id = $1", [
      this.agentId,
    ]);
  }

  /** Gracefully shut down the connection pool */
  async close(): Promise<void> {
    await this.pool.end();
  }

  private rowToRecord(row: PaymentRow): PaymentRecord {
    let metadata: Record<string, string> = {};
    try {
      // Postgres JSONB is already parsed by pg driver, but handle string case defensively
      metadata =
        typeof row.metadata === "string"
          ? (JSON.parse(row.metadata as unknown as string) as Record<string, string>)
          : (row.metadata as Record<string, string>);
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
