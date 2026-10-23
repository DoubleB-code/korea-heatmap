/**
 * 정산 Cron Handler.
 *
 * 흐름:
 *   1. 영업일 가드 (휴장일 SKIP)
 *   2. 미정산 베팅(target_date <= 오늘) 조회
 *   3. 종목별 Yahoo 종가 fetch (캐시 우선)
 *   4. 각 베팅 outcome 계산 + DB 업데이트 (트랜잭션)
 *   5. users 통계 + streak 갱신
 *   6. HoF 자격 재평가 (적중률 60% / 30회 / 30일 활동)
 *   7. audit_log 기록
 *
 * Cron 시점: 매일 17:30 KST (08:30 UTC, 평일).
 *   - KRX 마감(15:30) + 종가 동시호가 반영
 *   - Yahoo Finance 갱신 대기 ~1시간 여유
 *
 * VOID 처리:
 *   - 거래정지 / 종가 null / 거래량 0 → 점수 환불, 통계 미반영
 *   - 휴장일이 target_date 인 경우 정산 보류 (다음 영업일까지 settled=0 유지)
 */
import type { Env } from "../types";
import { fetchYahooClose } from "../lib/yahoo";
import { getActiveHolidaySet } from "../lib/holidays";
import { isBusinessDay, todayKST, nowUnix } from "../lib/kst";

const DEAD_ZONE_PCT_DEFAULT = 0.1;
const PAYOUT_RATIO = 1.0;        // 1:1 (적중 시 베팅액 + 동일액)
const HOF_MIN_BETS = 30;
const HOF_MIN_WIN_RATE = 0.60;
const HOF_ACTIVITY_DAYS = 30;

interface BetRow {
  id: number;
  user_id: string;
  ticker: string;
  ticker_name: string;
  target_date: string;
  direction: "UP" | "DOWN" | "PASS";
  amount: number;
  baseline_price: number;
}

/**
 * Cron 진입점. wrangler scheduled handler 가 이걸 호출.
 */
export async function runSettlement(env: Env): Promise<{ settled: number; voided: number; errors: number }> {
  const today = todayKST();
  const holidays = getActiveHolidaySet();

  await logAudit(env, "SETTLE_START", { today, holidays_size: holidays.size });

  // 1) 영업일 가드 — 오늘이 휴장이면 정산 자체 SKIP
  if (!isBusinessDay(today, holidays)) {
    await logAudit(env, "SETTLE_SKIP_HOLIDAY", { today });
    return { settled: 0, voided: 0, errors: 0 };
  }

  // 2) 미정산 베팅 조회 — target_date <= today AND settled=0
  const unsettled = await env.DB.prepare(`
    SELECT id, user_id, ticker, ticker_name, target_date, direction, amount, baseline_price
    FROM bets
    WHERE settled = 0 AND direction IN ('UP', 'DOWN') AND target_date <= ?
    ORDER BY target_date, ticker
  `).bind(today).all<BetRow>();

  const bets = unsettled.results;
  if (bets.length === 0) {
    await logAudit(env, "SETTLE_NO_PENDING", { today });
    return { settled: 0, voided: 0, errors: 0 };
  }

  // 3) 정산 대상일 별로 그룹화 (target_date 가 휴장일이면 보류)
  const byDate = new Map<string, BetRow[]>();
  for (const bet of bets) {
    if (!isBusinessDay(bet.target_date, holidays)) continue;  // 휴장일 target → 다음 cron 대기
    if (!byDate.has(bet.target_date)) byDate.set(bet.target_date, []);
    byDate.get(bet.target_date)!.push(bet);
  }

  let settled = 0, voided = 0, errors = 0;
  const deadZonePct = parseFloat(env.DEAD_ZONE_PCT) || DEAD_ZONE_PCT_DEFAULT;

  // 4) 날짜 × 종목 × 베팅 처리
  for (const [targetDate, dateBets] of byDate) {
    // 해당 날짜의 유니크 ticker 추출
    const tickers = [...new Set(dateBets.map(b => b.ticker))];

    // 종목별 종가 일괄 fetch (캐시 우선)
    const priceMap = new Map<string, { close: number | null; status: string }>();
    for (const tk of tickers) {
      // closing_prices 캐시 확인
      const cached = await env.DB.prepare(
        "SELECT close FROM closing_prices WHERE ticker = ? AND date = ?"
      ).bind(tk, targetDate).first<{ close: number }>();

      if (cached) {
        priceMap.set(tk, { close: cached.close, status: "OK" });
        continue;
      }

      // Yahoo 호출
      const yahoo = await fetchYahooClose(tk);
      if (yahoo.status === "OK" && yahoo.close !== null && yahoo.data_date === targetDate) {
        priceMap.set(tk, { close: yahoo.close, status: "OK" });
        // 캐시 저장
        env.DB.prepare(`
          INSERT OR REPLACE INTO closing_prices (ticker, date, close, volume, fetched_at, source)
          VALUES (?, ?, ?, ?, ?, 'yahoo')
        `).bind(tk, targetDate, yahoo.close, yahoo.volume ?? 0, nowUnix()).run().catch(() => {});
      } else if (yahoo.status === "VOID") {
        priceMap.set(tk, { close: null, status: "VOID" });
      } else {
        priceMap.set(tk, { close: null, status: "FAIL" });
      }
    }

    // 베팅 별 outcome 계산
    for (const bet of dateBets) {
      const priceInfo = priceMap.get(bet.ticker);
      if (!priceInfo) { errors++; continue; }

      if (priceInfo.status === "FAIL") {
        // Yahoo 실패 — 정산 보류 (다음 cron 재시도)
        errors++;
        continue;
      }

      let outcome: "WIN" | "LOSE" | "VOID";
      let payout: number;
      let actualPrice: number | null = null;
      let actualChangePct: number | null = null;

      if (priceInfo.status === "VOID" || priceInfo.close === null) {
        outcome = "VOID";
        payout = bet.amount;  // 환불
      } else {
        actualPrice = priceInfo.close;
        actualChangePct = (actualPrice - bet.baseline_price) / bet.baseline_price * 100;

        if (Math.abs(actualChangePct) < deadZonePct) {
          outcome = "VOID";
          payout = bet.amount;
        } else {
          const isUp = actualChangePct > 0;
          const won = (bet.direction === "UP" && isUp) || (bet.direction === "DOWN" && !isUp);
          if (won) {
            outcome = "WIN";
            payout = bet.amount + Math.floor(bet.amount * PAYOUT_RATIO);
          } else {
            outcome = "LOSE";
            payout = 0;
          }
        }
      }

      const settledAt = nowUnix();
      const netChange = payout - bet.amount;  // 사용자 점수 순변화

      // 트랜잭션
      await env.DB.batch([
        env.DB.prepare(`
          UPDATE bets SET
            settled = 1, outcome = ?, payout = ?,
            actual_price = ?, actual_change_pct = ?,
            settled_at = ?
          WHERE id = ?
        `).bind(outcome, payout, actualPrice, actualChangePct, settledAt, bet.id),

        env.DB.prepare(`
          UPDATE users SET
            points = points + ?,
            total_wins = total_wins + ?,
            total_voids = total_voids + ?,
            last_seen_at = ?
          WHERE id = ?
        `).bind(
          netChange,
          outcome === "WIN" ? 1 : 0,
          outcome === "VOID" ? 1 : 0,
          settledAt,
          bet.user_id,
        ),
      ]);

      if (outcome === "VOID") voided++;
      else settled++;
    }
  }

  // 5) HoF 자격 재평가 (적중률 + 활동 기준 미달 사용자 강등)
  await reevaluateHallOfFame(env);

  await logAudit(env, "SETTLE_DONE", { settled, voided, errors });
  return { settled, voided, errors };
}

/**
 * 명예의 전당 자격 재평가.
 *
 * 기준:
 *   - 정산 베팅 (WIN+LOSE) >= 30
 *   - 적중률 >= 60%
 *   - 최근 30일 내 베팅 존재
 *
 * 통과 → is_pro=1, pro_qualified_at 갱신
 * 미달 → is_pro=0 (단 pro_qualified_at 보존 = 이력)
 *
 * 마이그레이션 0002 적용 후 활성화 — 컬럼 미존재 시 silently skip.
 */
async function reevaluateHallOfFame(env: Env): Promise<void> {
  // 컬럼 존재 확인 (마이그레이션 0002 미적용 환경 대응)
  const colsRow = await env.DB.prepare(
    "SELECT name FROM pragma_table_info('users') WHERE name = 'is_pro'"
  ).first<{ name: string }>();
  if (!colsRow) return;  // 마이그레이션 미적용 — skip

  const thirtyDaysAgo = nowUnix() - HOF_ACTIVITY_DAYS * 86400;

  // 자격 통과 사용자
  await env.DB.prepare(`
    UPDATE users SET is_pro = 1, pro_qualified_at = COALESCE(pro_qualified_at, ?)
    WHERE id IN (
      SELECT u.id FROM users u
      WHERE u.banned = 0 AND u.last_seen_at >= ?
        AND (
          SELECT COUNT(*) FROM bets b
          WHERE b.user_id = u.id AND b.settled = 1 AND b.outcome IN ('WIN','LOSE')
        ) >= ?
        AND (
          SELECT CAST(SUM(CASE WHEN b.outcome='WIN' THEN 1 ELSE 0 END) AS REAL)
                 / COUNT(*) FROM bets b
          WHERE b.user_id = u.id AND b.settled = 1 AND b.outcome IN ('WIN','LOSE')
        ) >= ?
    )
  `).bind(nowUnix(), thirtyDaysAgo, HOF_MIN_BETS, HOF_MIN_WIN_RATE).run();

  // 자격 미달 사용자 강등 (활동 없거나 적중률 떨어짐)
  await env.DB.prepare(`
    UPDATE users SET is_pro = 0
    WHERE is_pro = 1 AND (
      last_seen_at < ?
      OR (
        SELECT COUNT(*) FROM bets b
        WHERE b.user_id = users.id AND b.settled = 1 AND b.outcome IN ('WIN','LOSE')
      ) < ?
      OR (
        SELECT CAST(SUM(CASE WHEN b.outcome='WIN' THEN 1 ELSE 0 END) AS REAL)
               / NULLIF(COUNT(*), 0) FROM bets b
        WHERE b.user_id = users.id AND b.settled = 1 AND b.outcome IN ('WIN','LOSE')
      ) < ?
    )
  `).bind(thirtyDaysAgo, HOF_MIN_BETS, HOF_MIN_WIN_RATE).run();
}

async function logAudit(env: Env, event: string, meta: any): Promise<void> {
  try {
    await env.DB.prepare(
      "INSERT INTO audit_log (ts, event, meta_json) VALUES (?, ?, ?)"
    ).bind(nowUnix(), event, JSON.stringify(meta)).run();
  } catch {}
}
