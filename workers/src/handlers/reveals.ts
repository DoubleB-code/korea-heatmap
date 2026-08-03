/**
 * 베팅 열람 시장 API.
 */
import type { Env } from "../types";
import { jsonResponse, errorResponse } from "../lib/responses";
import { getCurrentUser } from "../lib/auth";
import { nowUnix, todayKST, isBusinessDay } from "../lib/kst";
import { getActiveHolidaySet } from "../lib/holidays";
import { tierOf } from "./hof";

const REFUND_RATIO = 0.5;

export async function handleSubmitReveal(req: Request, env: Env): Promise<Response> {
  const viewer = await getCurrentUser(req, env);
  if (!viewer) {
    return errorResponse(401, "NO_SESSION", "쿠키 없음", req, env);
  }
  if (((viewer as any).auth_provider || "anon") === "anon") {
    return errorResponse(401, "AUTH_REQUIRED", "고수 예측 열람은 로그인 후 가능합니다.", req, env);
  }

  let body: any;
  try { body = await req.json(); }
  catch { return errorResponse(400, "INVALID_JSON", "JSON 파싱 실패", req, env); }

  let targetUserId = String(body.target_user_id || "").trim();
  const targetNickname = String(body.target_nickname || "").trim();
  const targetDate = String(body.target_date || "").trim();

  if (!targetUserId && targetNickname) {
    const row = await env.DB.prepare(
      `SELECT id FROM users WHERE nickname = ? AND banned = 0`
    ).bind(targetNickname).first<{ id: string }>();
    targetUserId = row?.id || "";
  }

  if (!targetUserId) {
    return errorResponse(400, "MISSING_TARGET", "target_user_id 또는 target_nickname 필수", req, env);
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(targetDate)) {
    return errorResponse(400, "INVALID_DATE", "target_date 형식 YYYY-MM-DD", req, env);
  }
  if (targetUserId === viewer.id) {
    return errorResponse(400, "SELF_REVEAL", "본인 베팅은 열람 불가", req, env);
  }

  const target = await env.DB.prepare(`
    SELECT id, nickname, bets_public, is_pro, banned
    FROM users WHERE id = ?
  `).bind(targetUserId).first<any>();

  if (!target || target.banned) {
    return errorResponse(404, "TARGET_NOT_FOUND", "사용자 없음", req, env);
  }
  if (!target.is_pro) {
    return errorResponse(403, "NOT_HOF", "이 사용자는 명예의 전당 미진입", req, env);
  }
  if (!target.bets_public) {
    return errorResponse(403, "PRIVATE", "이 사용자는 베팅 비공개 설정", req, env);
  }

  const existing = await env.DB.prepare(`
    SELECT id FROM bet_reveals
    WHERE viewer_user_id = ? AND target_user_id = ? AND target_date = ?
  `).bind(viewer.id, targetUserId, targetDate).first<{ id: number }>();
  if (existing) {
    return await respondWithBets(env, targetUserId, targetDate, req);
  }

  const holidays = getActiveHolidaySet();
  const today = todayKST();
  if (targetDate < today || (targetDate === today && !isBusinessDay(today, holidays))) {
    return await respondWithBets(env, targetUserId, targetDate, req);
  }

  const stat = await env.DB.prepare(`
    SELECT
      SUM(CASE WHEN outcome='WIN' THEN 1 ELSE 0 END) AS wins,
      SUM(CASE WHEN outcome IN ('WIN','LOSE') THEN 1 ELSE 0 END) AS decided
    FROM bets WHERE user_id = ? AND settled = 1
  `).bind(targetUserId).first<{ wins: number; decided: number }>();

  const winRate = (stat?.decided || 0) > 0 ? (stat?.wins || 0) / (stat?.decided || 1) : 0;
  const { tier, price } = tierOf(winRate);
  if (tier === "NONE") {
    return errorResponse(403, "TIER_NONE", "타겟 적중률 60% 미만 — 열람 불가", req, env);
  }
  if (viewer.points < price) {
    return errorResponse(400, "INSUFFICIENT_POINTS", `필요 ${price}점, 보유 ${viewer.points}점`, req, env);
  }

  const refund = Math.floor(price * REFUND_RATIO);
  const ts = nowUnix();

  await env.DB.batch([
    env.DB.prepare(`
      INSERT INTO bet_reveals (viewer_user_id, target_user_id, target_date, cost, refund, revealed_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `).bind(viewer.id, targetUserId, targetDate, price, refund, ts),
    env.DB.prepare(`UPDATE users SET points = points - ? WHERE id = ?`).bind(price, viewer.id),
    env.DB.prepare(`UPDATE users SET points = points + ? WHERE id = ?`).bind(refund, targetUserId),
    env.DB.prepare(`
      INSERT INTO points_ledger (user_id, delta, reason, ref_id, balance_after, ts)
      VALUES (?, ?, 'REVEAL_PAID', ?, ?, ?)
    `).bind(viewer.id, -price, `${targetUserId}:${targetDate}`, viewer.points - price, ts),
    env.DB.prepare(`
      INSERT INTO points_ledger (user_id, delta, reason, ref_id, balance_after, ts)
      SELECT id, ?, 'REVEAL_EARNED', ?, points, ?
      FROM users WHERE id = ?
    `).bind(refund, `${viewer.id}:${targetDate}`, ts, targetUserId),
  ]);

  return await respondWithBets(env, targetUserId, targetDate, req, {
    paid: price,
    target_earned: refund,
  });
}

async function respondWithBets(
  env: Env,
  targetUserId: string,
  targetDate: string,
  req: Request,
  payInfo?: { paid: number; target_earned: number },
): Promise<Response> {
  const result = await env.DB.prepare(`
    SELECT ticker, ticker_name, direction, amount, baseline_price,
           settled, outcome, actual_price, actual_change_pct
    FROM bets
    WHERE user_id = ? AND target_date = ? AND direction IN ('UP','DOWN')
    ORDER BY bet_at
  `).bind(targetUserId, targetDate).all();

  const target = await env.DB.prepare(`
    SELECT nickname FROM users WHERE id = ?
  `).bind(targetUserId).first<{ nickname: string }>();

  return jsonResponse({
    target_nickname: target?.nickname || "(unknown)",
    target_date: targetDate,
    bets: result.results,
    pay_info: payInfo || null,
    free: !payInfo,
  }, {}, req, env);
}

export async function handleGetReveal(
  req: Request, env: Env, targetUserId: string, targetDate: string,
): Promise<Response> {
  const viewer = await getCurrentUser(req, env);
  if (!viewer) {
    return errorResponse(401, "NO_SESSION", "쿠키 없음", req, env);
  }

  if (targetUserId === viewer.id) {
    return await respondWithBets(env, targetUserId, targetDate, req);
  }

  const today = todayKST();
  if (targetDate < today) {
    return await respondWithBets(env, targetUserId, targetDate, req);
  }

  const paid = await env.DB.prepare(`
    SELECT cost FROM bet_reveals
    WHERE viewer_user_id = ? AND target_user_id = ? AND target_date = ?
  `).bind(viewer.id, targetUserId, targetDate).first<{ cost: number }>();

  if (!paid) {
    return errorResponse(402, "PAYMENT_REQUIRED", "결제 후 열람 가능", req, env);
  }

  return await respondWithBets(env, targetUserId, targetDate, req);
}

export async function handleMyReveals(req: Request, env: Env): Promise<Response> {
  const viewer = await getCurrentUser(req, env);
  if (!viewer) {
    return errorResponse(401, "NO_SESSION", "쿠키 없음", req, env);
  }

  const url = new URL(req.url);
  const limit = Math.min(50, parseInt(url.searchParams.get("limit") || "20", 10));

  const result = await env.DB.prepare(`
    SELECT r.target_user_id, u.nickname AS target_nickname,
           r.target_date, r.cost, r.revealed_at
    FROM bet_reveals r
    INNER JOIN users u ON u.id = r.target_user_id
    WHERE r.viewer_user_id = ?
    ORDER BY r.revealed_at DESC
    LIMIT ?
  `).bind(viewer.id, limit).all();

  return jsonResponse({ reveals: result.results }, {}, req, env);
}
