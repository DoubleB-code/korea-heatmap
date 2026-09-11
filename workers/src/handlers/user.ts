/**
 * 사용자 관련 API.
 */
import type { Env, User } from "../types";
import {
  generateUuid, generateNickname, getCurrentUser,
  buildSetCookieHeader, hashIp,
} from "../lib/auth";
import { jsonResponse, errorResponse } from "../lib/responses";
import { nowUnix, todayKST } from "../lib/kst";

const IP_DAILY_USER_LIMIT = 5;

export async function handleUserInit(req: Request, env: Env): Promise<Response> {
  const existing = await getCurrentUser(req, env);
  if (existing) {
    return jsonResponse({ user: existing, isNew: false }, {}, req, env);
  }

  const ip = req.headers.get("CF-Connecting-IP") || "0.0.0.0";
  const ipHash = await hashIp(ip);
  const today = todayKST();

  const ipRow = await env.DB
    .prepare("SELECT user_creations FROM ip_rate_limit WHERE ip_hash = ? AND date = ?")
    .bind(ipHash, today)
    .first<{ user_creations: number }>();

  if (ipRow && ipRow.user_creations >= IP_DAILY_USER_LIMIT) {
    return errorResponse(429, "IP_LIMIT_EXCEEDED", "오늘 이 네트워크에서 너무 많은 신규 가입이 발생했습니다.", req, env);
  }

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

  const user = await env.DB.prepare("SELECT * FROM users WHERE id = ?").bind(userId).first<User>();
  const response = jsonResponse({ user, isNew: true }, {}, req, env);
  response.headers.set("Set-Cookie", buildSetCookieHeader(userId, env));
  return response;
}

export async function handleMe(req: Request, env: Env): Promise<Response> {
  const user = await getCurrentUser(req, env);
  if (!user) {
    return errorResponse(401, "NO_SESSION", "쿠키가 없거나 만료됨", req, env);
  }

  const settledRow = await env.DB.prepare(`
    SELECT
      COUNT(*) FILTER (WHERE outcome = 'WIN') AS wins,
      COUNT(*) FILTER (WHERE outcome = 'LOSE') AS losses,
      COUNT(*) FILTER (WHERE outcome = 'VOID') AS voids
    FROM bets WHERE user_id = ? AND settled = 1
  `).bind(user.id).first<{ wins: number; losses: number; voids: number }>();

  const wins = settledRow?.wins || 0;
  const losses = settledRow?.losses || 0;
  const voids = settledRow?.voids || 0;
  const totalSettled = wins + losses;
  const winRate = totalSettled > 0 ? wins / totalSettled : null;

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
      display_name: (user as any).display_name || null,
      avatar_url: (user as any).avatar_url || null,
      auth_provider: (user as any).auth_provider || "anon",
      points: user.points,
      created_at: user.created_at,
      streak_days: user.streak_days,
      is_pro: Boolean((user as any).is_pro || 0),
      bets_public: Boolean((user as any).bets_public ?? 1),
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

export async function handleSetPrivacy(req: Request, env: Env): Promise<Response> {
  const user = await getCurrentUser(req, env);
  if (!user) {
    return errorResponse(401, "NO_SESSION", "쿠키 없음", req, env);
  }
  if (((user as any).auth_provider || "anon") === "anon") {
    return errorResponse(401, "AUTH_REQUIRED", "로그인 후 공개 설정을 변경하세요.", req, env);
  }

  let body: any;
  try { body = await req.json(); }
  catch { return errorResponse(400, "INVALID_JSON", "JSON 파싱 실패", req, env); }

  if (typeof body.bets_public !== "boolean") {
    return errorResponse(400, "INVALID_FIELD", "bets_public 는 boolean", req, env);
  }

  const colCheck = await env.DB.prepare(
    "SELECT name FROM pragma_table_info('users') WHERE name = 'bets_public'"
  ).first<{ name: string }>();
  if (!colCheck) {
    return errorResponse(503, "MIGRATION_PENDING", "마이그레이션 0002 적용 필요", req, env);
  }

  await env.DB.prepare(
    "UPDATE users SET bets_public = ? WHERE id = ?"
  ).bind(body.bets_public ? 1 : 0, user.id).run();

  return jsonResponse({
    bets_public: body.bets_public,
    note: body.bets_public
      ? "베팅 공개 ON — 명예의 전당 입성 시 다른 사용자가 포인트로 열람 가능"
      : "베팅 비공개 — 명예의 전당 입성해도 베팅 노출 안 됨",
  }, {}, req, env);
}

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