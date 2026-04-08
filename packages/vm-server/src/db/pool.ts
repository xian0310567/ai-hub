/**
 * PostgreSQL 연결 풀 + 쿼리 헬퍼
 *
 * 테스트 시 setPool()로 pg-mem 풀을 주입한다.
 * 운영 시 DATABASE_URL 환경변수를 사용한다.
 */

import pg from 'pg';
import crypto from 'crypto';

const { Pool } = pg;
export type PoolType = InstanceType<typeof Pool>;

let _pool: PoolType | null = null;

export function setPool(p: PoolType): void { _pool = p; }

export function getPool(): PoolType {
  if (!_pool) {
    _pool = new Pool({
      connectionString: process.env.DATABASE_URL
        ?? 'postgres://postgres:postgres@localhost:5432/aihub',
      max: 20,
      idleTimeoutMillis: 30_000,
    });
  }
  return _pool;
}

/** SQLite ? placeholder → PostgreSQL $1, $2, ... 자동 변환 */
function pgify(sql: string): string {
  let n = 0;
  return sql.replace(/\?/g, () => `$${++n}`);
}

/** 단일 행 조회 */
export async function q1<T = Record<string, unknown>>(
  sql: string,
  params?: unknown[],
): Promise<T | undefined> {
  const { rows } = await getPool().query(pgify(sql), params);
  return rows[0] as T | undefined;
}

/** 다중 행 조회 */
export async function qall<T = Record<string, unknown>>(
  sql: string,
  params?: unknown[],
): Promise<T[]> {
  const { rows } = await getPool().query(pgify(sql), params);
  return rows as T[];
}

/** INSERT / UPDATE / DELETE (반환값 없음) */
export async function exec(sql: string, params?: unknown[]): Promise<void> {
  await getPool().query(pgify(sql), params);
}

/** RETURNING * 포함 쿼리용 — 첫 번째 행 반환 */
export async function execReturning<T = Record<string, unknown>>(
  sql: string,
  params?: unknown[],
): Promise<T | undefined> {
  const { rows } = await getPool().query(pgify(sql), params);
  return rows[0] as T | undefined;
}

/**
 * 동적 WHERE 절 빌더.
 * base: 이미 $1... 번호가 적용된 기본 쿼리 ("SELECT ... WHERE org_id = $1")
 * baseParams: base 쿼리의 파라미터 배열
 * conditions: [절 문자열("col = ?"), 값] 또는 null (조건 미적용)
 */
export function buildWhere(
  base: string,
  baseParams: unknown[],
  conditions: Array<[string, unknown] | null | undefined>,
): [string, unknown[]] {
  let n = baseParams.length;
  const params: unknown[] = [...baseParams];
  const clauses: string[] = [];

  for (const cond of conditions) {
    if (!cond) continue;
    const [clause, val] = cond;
    params.push(val);
    clauses.push(clause.replace('?', `$${++n}`));
  }

  const sql = clauses.length ? `${base} AND ${clauses.join(' AND ')}` : base;
  return [sql, params];
}

export const newId = (): string => crypto.randomUUID();
export const now = (): number => Math.floor(Date.now() / 1000);
