/**
 * 리더보드 API.
 *   GET /api/leaderboard?period=daily|weekly|monthly&metric=points|winrate
 *
 * - 익명 닉네임 노출 (id 노출 X)
 * - banned 사용자 제외
 * - winrate 모드는 최소 베팅 수 가드 (5회 이상)
 * - 결과는 1분 메모리 캐시는 안 함 (D1 빠르고 트래픽 작음)
 */
import type { Env } from "../types";
import { jsonResponse, errorResponse } from "../lib/responses";
import { getCurrentUser } from "../lib/auth";

const MIN_BETS_FOR_WINRATE = 5;
const TOP_N = 50;

export async function handleLeaderboard(req: Request, env: Env): Promise<Response> {
  const url = new URL(req.url);
  const period = url.searchParams.get("period") || "monthly";
  const metric = url.searchParams.get("metric") || "points";

  if (!["daily", "weekly", "monthly", "all"].includes(period)) {
    return errorResponse(400, "INVALID_PERIOD",
      "period는 daily/weekly/monthly/all", req, env);
  }
  if (!["points", "winrate"].includes(metric)) {
    return errorResponse(400, "INVALID_METRIC", "metric은 points/winrate", req, env);
  }

  // 기간 → 시작 unix sec
  const now = Math.floor(Date.now() / 1000);
  let sinceSec = 0;
  switch (period) {
    case "daily":   sinceSec = now - 86400; break;
    case "weekly":  sinceSec = now - 86400 * 7; break;
    case "monthly": sinceSec = now - 86400 * 30; break;
    case "all":     sinceSec = 0; break;
  }

  // 메인 쿼리 — period 기간 내 정산된 베팅 기준 집계
  let rows;
  if (metric === "points") {
    // 기간 내 payout 변화 누적 (point gain)
    const result = await env.DB.prepare(`
      SELECT
        u.id, u.nickname,
        u.points AS current_points,
        COALESCE(SUM(b.payout - b.amount), 0) AS period_change,
        COUNT(b.id) AS settled_bets,
        SUM(CASE WHEN b.outcome = 'WIN' THEN 1 ELSE 0 END) AS wins
      FROM users u
      LEFT JOIN bets b ON b.user_id = u.id AND b.settled = 1 AND b.settled_at >= ?
      WHERE u.banned = 0
      GROUP BY u.id
      HAVING settled_bets > 0 OR ? = 0
      ORDER BY period_change DESC, u.points DESC
      LIMIT ?
    `).bind(sinceSec, sinceSec, TOP_N).all();
    rows = result.results;
  } else {
    // winrate — VOID 제외
    const result = await env.DB.prepare(`
      SELECT
        u.id, u.nickname,
        u.points AS current_points,
        SUM(CASE WHEN b.outcome = 'WIN' THEN 1 ELSE 0 END) AS wins,
        SUM(CASE WHEN b.outcome = 'LOSE' THEN 1 ELSE 0 END) AS losses,
        SUM(CASE WHEN b.outcome IN ('WIN','LOSE') THEN 1 ELSE 0 END) AS decided
      FROM users u
      INNER JOIN bets b ON b.user_id = u.id
        AND b.settled = 1
        AND b.settled_at >= ?
        AND b.outcome IN ('WIN','LOSE')
      WHERE u.banned = 0
      GROUP BY u.id
      HAVING decided >= ?
      ORDER BY (CAST(wins AS REAL) / decided) DESC, decided DESC
      LIMIT ?
    `).bind(sinceSec, MIN_BETS_FOR_WINRATE, TOP_N).all();
    rows = result.results;
  }

  // 현재 사용자 위치 계산 (있다면)
  const currentUser = await getCurrentUser(req, env);
  let myRank: number | null = null;
  if (currentUser) {
    const meIdx = rows.findIndex(r => (r as any).id === currentUser.id);
    if (meIdx >= 0) myRank = meIdx + 1;
  }

  // 응답에는 id 제거 (익명성)
  const ranked = rows.map((r: any, i: number) => {
    const item: any = {
      rank: i + 1,
      nickname: r.nickname,
      current_points: r.current_points,
      settled_bets: r.settled_bets ?? r.decided ?? 0,
    };
    if (metric === "winrate") {
      item.wins = r.wins;
      item.losses = r.losses;
      item.win_rate = r.decided > 0 ? r.wins / r.decided : null;
    } else {
      item.period_change = r.period_change ?? 0;
      item.wins = r.wins ?? 0;
    }
    return item;
  });

  return jsonResponse({
    period,
    metric,
    top: ranked,
    my_rank: myRank,
    note: metric === "winrate"
      ? `적중률은 정산 ${MIN_BETS_FOR_WINRATE}회 이상 사용자 한정`
      : null,
  }, {}, req, env);
}
