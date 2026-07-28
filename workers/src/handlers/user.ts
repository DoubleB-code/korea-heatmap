/**
 * 사용자 관련 API.
 *   POST /api/user/init  - 익명 사용자 생성 (또는 기존 쿠키로 복귀)
 *   GET  /api/me         - 내 통계 + 점수
 *   GET  /api/me/history - 최근 베팅 이력
 */
import type { Env, User } from "../types";
import {
  generateUuid, generateNickname, getCurrentUser,
  getUserIdFromCookie, buildSetCookieHeader, hashIp,
} from "../lib/auth";
import { jsonResponse, errorResponse } from "../lib/responses";
import { nowUnix, todayKST } from "../lib/kst";

// IP 당 일 신규 가입 한도 (어뷰징 방어)
const IP_DAILY_USER_LIMIT = 5;

/**
 * POST /api/user/init
 *
 * 응답:
 *   { user: User, isNew: boolean }
 * Set-Cookie 헤더로 kh_uid 발급/유지.
 */
export async function handleUserInit(req: Request, env: Env): Promise<Response> {
  const existing = await getCurrentUser(req, env);
  if (existing) {
    return jsonResponse({ user: existing, isNew: false }, {}, req, env);
  }

  // 쿠키가 있는데 DB에 없는 경우 = 만료된 쿠키 or DB 초기화 후
  const oldUid = getUserIdFromCookie(req);

  // IP 레이트리밋
  const ip = req.headers.get("CF-Connecting-IP") || "0.0.0.0";
  const ipHash = await hashIp(ip);
  const today = todayKST();

  const ipRow = await env.DB
    .prepare("SELECT user_creations FROM ip_rate_limit WHERE ip_hash = ? AND date = ?")
    .bind(ipHash, today)
    .first<{ user_creations: number }>();

  if (ipRow && ipRow.user_creations >= IP_DAILY_USER_LIMIT) {
    return errorResponse(429, "IP_LIMIT_EXCEEDED",
      "오늘 이 네트워크에서 너무 많은 신규 가입이 발생했습니다.", req, env);
  }

  // 사용자 생성
  const userId = generateUuid();
  const nickname = generateNickname();
  const initialPoints = parseInt(env.INITIAL_POINTS, 10) || 1000;
  const now = nowUnix();

  await env.DB.batch([
    env.DB.prepare(`
      INSERT INTO users (id, nickname, created_at, last_seen_at, points)
      VALUES (?, ?, ?, ?, ?)
    `).bind(userId, nickname, now, now, initialPoints),

    env.DB.prepare(`
      INSERT INTO ip_rate_limit (ip_hash, date, user_creations)
      VALUES (?, ?, 1)
      ON CONFLICT(ip_hash, date) DO UPDATE
      SET user_creations = user_creations + 1
    `).bind(ipHash, today),
  ]);

  const user = await env.DB
    .prepare("SELECT * FROM users WHERE id = ?")
    .bind(userId)
    .first<User>();

  const response = jsonResponse({ user, isNew: true }, {}, req, env);
  response.headers.set("Set-Cookie", buildSetCookieHeader(userId, env));
  return response;
}

/**
 * GET /api/me
 */
export async function handleMe(req: Request, env: Env): Promise<Response> {
  const user = await getCurrentUser(req, env);
  if (!user) {
    return errorResponse(401, "NO_SESSION", "쿠키가 없거나 만료됨", req, env);
  }

  // 통계 계산
  const settledRow = await env.DB.prepare(`
    SELECT
      COUNT(*) FILTER (WHERE outcome = 'WIN')  AS wins,
      COUNT(*) FILTER (WHERE outcome = 'LOSE') AS losses,
      COUNT(*) FILTER (WHERE outcome = 'VOID') AS voids
    FROM bets WHERE user_id = ? AND settled = 1
  `).bind(user.id).first<{ wins: number; losses: number; voids: number }>();

  const wins = settledRow?.wins || 0;
  const losses = settledRow?.losses || 0;
  const voids = settledRow?.voids || 0;
  const totalSettled = wins + losses;  // VOID 제외 (적중률 계산용)
  const winRate = totalSettled > 0 ? wins / totalSettled : null;

  // 오늘 베팅 한도 잔여
  const today = todayKST();
  const quotaRow = await env.DB
    .prepare("SELECT count FROM daily_bet_count WHERE user_id = ? AND date = ?")
    .bind(user.id, today)
    .first<{ count: number }>();

  const usedToday = quotaRow?.count || 0;
  const dailyLimit = parseInt(env.DAILY_BET_LIMIT, 10) || 3;

  return jsonResponse({
    user: {
      id: user.id,
      nickname: user.nickname,
      points: user.points,
      created_at: user.created_at,
      streak_days: user.streak_days,
    },
    stats: {
      wins,
      losses,
      voids,
      win_rate: winRate,
      total_bets: user.total_bets,
    },
    today: {
      used: usedToday,
      limit: dailyLimit,
      remaining: Math.max(0, dailyLimit - usedToday),
    },
  }, {}, req, env);
}

/**
 * PATCH /api/me/privacy
 * body: { bets_public: true | false }
 */
export async function handleSetPrivacy(req: Request, env: Env): Promise<Response> {
  const user = await getCurrentUser(req, env);
  if (!user) {
    return errorResponse(401, "NO_SESSION", "쿠키 없음", req, env);
  }

  let body: any;
  try { body = await req.json(); }
  catch { return errorResponse(400, "INVALID_JSON", "JSON 파싱 실패", req, env); }

  if (typeof body.bets_public !== "boolean") {
    return errorResponse(400, "INVALID_FIELD",
      "bets_public 는 boolean", req, env);
  }

  // 컬럼 존재 가드
  const colCheck = await env.DB.prepare(
    "SELECT name FROM pragma_table_info('users') WHERE name = 'bets_public'"
  ).first<{ name: string }>();
  if (!colCheck) {
    return errorResponse(503, "MIGRATION_PENDING",
      "마이그레이션 0002 적용 필요", req, env);
  }

  await env.DB.prepare(
    "UPDATE users SET bets_public = ? WHERE id = ?"
  ).bind(body.bets_public ? 1 : 0, user.id).run();

  return jsonResponse({
    bets_public: body.bets_public,
    note: body.bets_public
      ? "베팅 공개 ON — HoF 입성 시 다른 사용자가 포인트로 베팅 열람 가능"
      : "베팅 비공개 — HoF 입성해도 베팅 노출 안 됨",
  }, {}, req, env);
}

/**
 * GET /api/me/history?limit=20
 */
export async function handleMyHistory(req: Request, env: Env): Promise<Response> {
  const user = await getCurrentUser(req, env);
  if (!user) {
    return errorResponse(401, "NO_SESSION", "쿠키 없음", req, env);
  }

  const url = new URL(req.url);
  const limit = Math.min(50, parseInt(url.searchParams.get("limit") || "20", 10));

  const rows = await env.DB.prepare(`
    SELECT id, ticker, ticker_name, target_date, direction, amount,
           baseline_price, bet_at, settled, outcome, actual_price,
           actual_change_pct, payout, settled_at
    FROM bets
    WHERE user_id = ?
    ORDER BY bet_at DESC
    LIMIT ?
  `).bind(user.id, limit).all();

  return jsonResponse({ bets: rows.results }, {}, req, env);
}
