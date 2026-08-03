/**
 * 명예의 전당 API.
 */
import type { Env } from "../types";
import { jsonResponse, errorResponse } from "../lib/responses";
import { getCurrentUser } from "../lib/auth";

const HOF_MIN_BETS = 30;

interface HofRow {
  user_id: string;
  nickname: string;
  display_name: string | null;
  avatar_url: string | null;
  decided_bets: number;
  wins: number;
  current_points: number;
  pro_qualified_at: number | null;
  bets_public: number;
}

export function tierOf(winRate: number): { tier: "GOLD"|"SILVER"|"BRONZE"|"NONE"; price: number; emoji: string } {
  if (winRate >= 0.70) return { tier: "GOLD", price: 200, emoji: "🏆" };
  if (winRate >= 0.65) return { tier: "SILVER", price: 100, emoji: "🥈" };
  if (winRate >= 0.60) return { tier: "BRONZE", price: 50, emoji: "🥉" };
  return { tier: "NONE", price: 0, emoji: "" };
}

export async function handleHof(req: Request, env: Env): Promise<Response> {
  const colCheck = await env.DB.prepare(
    "SELECT name FROM pragma_table_info('users') WHERE name = 'is_pro'"
  ).first<{ name: string }>();
  if (!colCheck) {
    return errorResponse(503, "MIGRATION_PENDING", "마이그레이션 0002 적용 필요", req, env);
  }

  const result = await env.DB.prepare(`
    SELECT
      u.id AS user_id,
      u.nickname,
      u.display_name,
      u.avatar_url,
      u.points AS current_points,
      u.pro_qualified_at,
      u.bets_public,
      SUM(CASE WHEN b.outcome='WIN' THEN 1 ELSE 0 END) AS wins,
      SUM(CASE WHEN b.outcome IN ('WIN','LOSE') THEN 1 ELSE 0 END) AS decided_bets
    FROM users u
    LEFT JOIN bets b ON b.user_id = u.id AND b.settled = 1
    WHERE u.banned = 0 AND u.is_pro = 1 AND u.bets_public = 1
    GROUP BY u.id
    HAVING SUM(CASE WHEN b.outcome IN ('WIN','LOSE') THEN 1 ELSE 0 END) >= ?
    ORDER BY (CAST(wins AS REAL) / NULLIF(decided_bets, 0)) DESC, decided_bets DESC, current_points DESC
    LIMIT 50
  `).bind(HOF_MIN_BETS).all<HofRow>();

  const users = result.results.map(u => {
    const decided = u.decided_bets || 0;
    const wins = u.wins || 0;
    const winRate = decided > 0 ? wins / decided : 0;
    const tier = tierOf(winRate);
    return {
      nickname: u.nickname,
      display_name: u.display_name,
      avatar_url: u.avatar_url,
      tier: tier.tier,
      tier_emoji: tier.emoji,
      reveal_price: tier.price,
      win_rate: Math.round(winRate * 10000) / 100,
      decided_bets: decided,
      wins,
      current_points: u.current_points,
      qualified_since: u.pro_qualified_at,
    };
  });

  const me = await getCurrentUser(req, env);
  const myIndex = me ? users.findIndex(u => u.nickname === me.nickname) : -1;

  return jsonResponse({
    users,
    total: users.length,
    my_status: me ? {
      is_hof: myIndex >= 0,
      rank_in_hof: myIndex >= 0 ? myIndex + 1 : null,
      bets_public: Boolean((me as any).bets_public ?? 1),
    } : null,
    note: `정산 베팅 ${HOF_MIN_BETS}회 이상 + 적중률 60% 이상 + 30일 활동 + 공개 설정`,
  }, {}, req, env);
}

export async function handleUserProfile(req: Request, env: Env, nickname: string): Promise<Response> {
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
