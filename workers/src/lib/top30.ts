/**
 * TOP30 universe 조회 + 결정적 종목 추첨.
 *
 * 결정적 추첨:
 *   seed = SHA-256(user_id + ":" + target_date + ":" + seq)
 *   index = seed의 첫 4바이트 → uint32 → mod universe.length
 *
 * 이렇게 하면:
 *   - 같은 (user_id, date, seq) 조합 → 항상 같은 종목 (멱등성)
 *   - 사용자별로 추첨 결과 달라짐 (모두 같은 종목이면 재미 없음)
 *   - 클라이언트가 시드를 컨트롤할 수 없음 (조작 방지)
 */
import type { Env, Top30Stock } from "../types";
import { todayKST } from "./kst";

/**
 * 현재 시점의 active universe 조회.
 * effective_from <= 오늘 <= effective_to 인 분기 행 1개.
 */
export async function getCurrentUniverse(env: Env): Promise<Top30Stock[]> {
  const today = todayKST();
  const row = await env.DB.prepare(`
    SELECT tickers_json FROM top30_universe
    WHERE effective_from <= ? AND effective_to >= ?
    ORDER BY effective_from DESC
    LIMIT 1
  `).bind(today, today).first<{ tickers_json: string }>();

  if (!row) {
    // Fallback — 분기 universe 가 없으면 가장 최근 행
    const fallback = await env.DB.prepare(`
      SELECT tickers_json FROM top30_universe
      ORDER BY effective_from DESC
      LIMIT 1
    `).first<{ tickers_json: string }>();
    if (!fallback) return [];
    return JSON.parse(fallback.tickers_json) as Top30Stock[];
  }

  return JSON.parse(row.tickers_json) as Top30Stock[];
}

/**
 * 결정적 종목 추첨.
 * 같은 입력 → 같은 출력 (멱등). 사용자별 다른 결과.
 */
export async function pickStock(
  userId: string,
  targetDate: string,
  seq: number,
  universe: Top30Stock[],
): Promise<Top30Stock> {
  if (universe.length === 0) {
    throw new Error("universe is empty");
  }

  const seed = `${userId}:${targetDate}:${seq}`;
  const data = new TextEncoder().encode(seed);
  const buf = await crypto.subtle.digest("SHA-256", data);
  const bytes = new Uint8Array(buf);

  // 첫 4바이트 → uint32 (big endian)
  const idx32 = ((bytes[0] << 24) | (bytes[1] << 16) | (bytes[2] << 8) | bytes[3]) >>> 0;
  const idx = idx32 % universe.length;

  return universe[idx];
}
