/**
 * 명예의 전당 (Hall of Fame) API.
 *
 *   GET /api/hof              - HoF 사용자 목록 (등급 + 가격 포함)
 *   GET /api/users/:nickname/profile  - 공개 프로필 (점수, 적중률, 등급)
 *
 * 등급 (적중률 기반 동적):
 *   - 🏆 Gold:   적중률 70%+ → 베팅 열람 200점
 *   - 🥈 Silver: 적중률 65-70% → 100점
 *   - 🥉 Bronze: 적중률 60-65% → 50점
 *   - 일반: 60% 미만 → 열람 불가
 *
 * 자격은 settle.ts 의 reevaluateHallOfFame() 에서 매일 갱신.
 * 여기선 is_pro=1 + bets_public=1 사용자만 노출.
 */
import type { Env } from "../types";
import { jsonResponse, errorResponse } from "../lib/responses";
import { getCurrentUser } from "../lib/auth";

const HOF_MIN_BETS = 30;

export interface HofUser {
  user_id: string;       // 내부용 — 응답에서 제거 (privacy)
  nickname: string;
  display_name: string | null;
  avatar_url: string | null;
  decided_bets: number;
  wins: number;
  win_rate: number;
  current_points: number;
  pro_qualified_at: number | null;
  bets_public: number;
}

/**
 * 적중률 → 등급 + 베팅 열람 가격.
 */
export function tierOf(winRate: number): { tier: "GOLD"|"SILVER"|"BRONZE"|"NONE"; price: number; emoji: string } {
  if (winRate >= 0.70) return { tier: "GOLD",   price: 200, emoji: "🏆" };
  if (winRate >= 0.65) return { tier: "SILVER", price: 100, emoji: "🥈" };
  if (winRate >= 0.60) return { tier: "BRONZE", price:  50, emoji: "🥉" };
  return { tier: "NONE", price: 0, emoji: "" };
}

/**
 * GET /api/hof
 *
 * 응답:
 *   { users: [{nickname, tier, price, win_rate, decided_bets, qualified_since, ...}] }
 */
export async function handleHof(req: Request, env: Env): Promise<Response> {
  // is_pro 컬럼 존재 확인 (마이그레이션 0002 미적용 환경 가드)
  const colCheck = await env.DB.prepare(
    "SELECT name FROM pragma_table_info('users') WHERE name = 'is_pro'"
  ).first<{ name: string }>();
  if (!colCheck) {
    return errorResponse(503, "MIGRATION_PENDING",
      "마이그레이션 0002 적용 필요", req, env);
  }

  // is_pro=1 + bets_public=1 사용자 + 통계 집계
  const result = await env.DB.prepare(`
    SELECT
      u.id, u.nickname, u.display_name, u.avatar_url,
      u.points AS current_points,
      u.pro_qualified_at, u.bets_public,
      SUM(CASE WHEN b.outcome='WIN' THEN 1 ELSE 0 END) AS wins,
      SUM(CASE WHEN b.outcome IN ('WIN','LOSE') THEN 1 ELSE 0 END) AS decided
    FROM users u
    LEFT JOIN bets b ON b.user_id = u.id AND b.settled = 1
    WHERE u.banned = 0 AND u.is_pro = 1 AND u.bets_public = 1
    GROUP BY u.id
    HAVING decided >= ?
    ORDER BY (CAST(wins AS REAL) / NULLIF(decided, 0)) DESC, decided DESC
    LIMIT 50
  `).bind(HOF_MIN_BETS).all<HofUser>();

  // 응답 정제
  const users = result.results.map(u => {
    const winRate = u.decided_bets > 0 ? u.wins / u.decided_bets : 0;
    const { tier, price, emoji } = tierOf(winRate);
    return {
      nickname: u.nickname,
      display_name: u.display_name,
      avatar_url: u.avatar_url,
      tier,
      tier_emoji: emoji,
      reveal_price: price,
      win_rate: Math.round(winRate * 10000) / 100,  // 67.42%
      decided_bets: u.decided_bets,
      wins: u.wins,
      qualified_since: u.pro_qualified_at,
    };
  });

  // 현재 사용자가 HoF 면 그 위치 표시
  const me = await getCurrentUser(req, env);
  let myStatus: any = null;
  if (me) {
    const meIdx = result.results.findIndex(r => r.user_id === me.id);
    myStatus = {
      is_hof: meIdx >= 0,
      rank_in_hof: meIdx >= 0 ? meIdx + 1 : null,
      bets_public: (me as any).bets_public ?? 1,
    };
  }

  return jsonResponse({
    users,
    total: users.length,
    my_status: myStatus,
    note: `정산 베팅 ${HOF_MIN_BETS}회 이상 + 적중률 60% 이상 + 30일 활동 + 공개 설정`,
  }, {}, req, env);
}

/**
 * GET /api/users/:nickname/profile
 *
 * 공개 프로필 — 누구나 조회 가능. id는 노출 안 함.
 */
export async function handleUserProfile(req: Request, env: Env, nickname: string): Promise<Response> {
  // 닉네임으로 사용자 조회
  const user = await env.DB.prepare(`
    SELECT id, nickname, display_name, avatar_url, points,
           total_bets, total_wins, total_voids,
           is_pro, pro_qualified_at, bets_public,
           created_at
    FROM users
    WHERE nickname = ? AND banned = 0
  `).bind(decodeURIComponent(nickname)).first<any>();

  if (!user) {
    return errorResponse(404, "USER_NOT_FOUND", "사용자 없음", req, env);
  }

  // 정산 통계
  const stat = await env.DB.prepare(`
    SELECT
      SUM(CASE WHEN outcome='WIN' THEN 1 ELSE 0 END) AS wins,
      SUM(CASE WHEN outcome='LOSE' THEN 1 ELSE 0 END) AS losses,
      SUM(CASE WHEN outcome IN ('WIN','LOSE') THEN 1 ELSE 0 END) AS decided
    FROM bets
    WHERE user_id = ? AND settled = 1
  `).bind(user.id).first<{ wins: number; losses: number; decided: number }>();

  const decided = stat?.decided || 0;
  const wins = stat?.wins || 0;
  const winRate = decided > 0 ? wins / decided : 0;
  const tier = tierOf(winRate);

  // 최근 정산 베팅 10건 (공개)
  const recentResult = await env.DB.prepare(`
    SELECT ticker, ticker_name, target_date, direction, amount,
           outcome, actual_change_pct, settled_at
    FROM bets
    WHERE user_id = ? AND settled = 1
    ORDER BY settled_at DESC
    LIMIT 10
  `).bind(user.id).all();

  return jsonResponse({
    user: {
      nickname: user.nickname,
      display_name: user.display_name,
      avatar_url: user.avatar_url,
      created_at: user.created_at,
      is_pro: !!user.is_pro,
      pro_qualified_at: user.pro_qualified_at,
      bets_public: !!user.bets_public,
    },
    stats: {
      wins,
      losses: stat?.losses || 0,
      decided,
      win_rate: Math.round(winRate * 10000) / 100,
      tier: tier.tier,
      tier_emoji: tier.emoji,
      reveal_price: tier.price,
      current_points: user.points,
    },
    recent_bets: recentResult.results,
  }, {}, req, env);
}
