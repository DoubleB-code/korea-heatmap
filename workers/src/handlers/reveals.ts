/**
 * 베팅 열람 시장 API.
 *
 *   POST /api/reveals
 *     body: { target_user_id, target_date }
 *     → 포인트 결제 (등급별 가격) + 50% 환원
 *     → 결제 성공 시 베팅 내용 반환
 *
 *   GET /api/reveals/:target_user_id/:date
 *     → 이미 결제했으면 베팅 내용 반환
 *     → 정산 후라면 무료 열람 가능
 *
 *   GET /api/me/reveals?limit=20
 *     → 내가 결제한 열람 기록
 *
 * 멱등성: 같은 (viewer, target, date) 한 번만 결제. 두 번째 호출은 무료.
 * 정산 후: 모든 사람 무료 (정산된 베팅은 누구나 봄).
 */
import type { Env } from "../types";
import { jsonResponse, errorResponse } from "../lib/responses";
import { getCurrentUser } from "../lib/auth";
import { nowUnix, todayKST, isBusinessDay } from "../lib/kst";
import { getActiveHolidaySet } from "../lib/holidays";
import { tierOf } from "./hof";

const REFUND_RATIO = 0.5;  // HoF 사용자에게 결제액의 50% 환원

/**
 * POST /api/reveals
 */
export async function handleSubmitReveal(req: Request, env: Env): Promise<Response> {
  const viewer = await getCurrentUser(req, env);
  if (!viewer) {
    return errorResponse(401, "NO_SESSION", "쿠키 없음", req, env);
  }

  let body: any;
  try { body = await req.json(); }
  catch { return errorResponse(400, "INVALID_JSON", "JSON 파싱 실패", req, env); }

  const targetUserId = String(body.target_user_id || "").trim();
  const targetDate = String(body.target_date || "").trim();

  if (!targetUserId) {
    return errorResponse(400, "MISSING_TARGET", "target_user_id 필수", req, env);
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(targetDate)) {
    return errorResponse(400, "INVALID_DATE", "target_date 형식 YYYY-MM-DD", req, env);
  }
  if (targetUserId === viewer.id) {
    return errorResponse(400, "SELF_REVEAL", "본인 베팅은 열람 불가", req, env);
  }

  // 타겟 사용자 조회 + HoF 확인
  const target = await env.DB.prepare(`
    SELECT id, nickname, bets_public, is_pro, banned
    FROM users WHERE id = ?
  `).bind(targetUserId).first<any>();

  if (!target || target.banned) {
    return errorResponse(404, "TARGET_NOT_FOUND", "사용자 없음", req, env);
  }
  if (!target.is_pro) {
    return errorResponse(403, "NOT_HOF",
      "이 사용자는 명예의 전당 미진입 (열람 불가)", req, env);
  }
  if (!target.bets_public) {
    return errorResponse(403, "PRIVATE",
      "이 사용자는 베팅을 비공개로 설정함", req, env);
  }

  // 이미 결제했으면 멱등 반환 (재과금 X)
  const existing = await env.DB.prepare(`
    SELECT id FROM bet_reveals
    WHERE viewer_user_id = ? AND target_user_id = ? AND target_date = ?
  `).bind(viewer.id, targetUserId, targetDate).first<{ id: number }>();

  if (existing) {
    return await respondWithBets(env, targetUserId, targetDate, viewer.id, req);
  }

  // 정산 후라면 무료 열람 (결제 기록 X)
  const holidays = getActiveHolidaySet();
  const today = todayKST();
  if (targetDate < today || (targetDate === today && !isBusinessDay(today, holidays))) {
    // 이미 지난 날짜는 무료
    return await respondWithBets(env, targetUserId, targetDate, viewer.id, req);
  }

  // 타겟의 적중률 → 가격 결정
  const stat = await env.DB.prepare(`
    SELECT
      SUM(CASE WHEN outcome='WIN' THEN 1 ELSE 0 END) AS wins,
      SUM(CASE WHEN outcome IN ('WIN','LOSE') THEN 1 ELSE 0 END) AS decided
    FROM bets WHERE user_id = ? AND settled = 1
  `).bind(targetUserId).first<{ wins: number; decided: number }>();

  const winRate = (stat?.decided || 0) > 0 ? (stat?.wins || 0) / (stat?.decided || 1) : 0;
  const { tier, price } = tierOf(winRate);

  if (tier === "NONE") {
    return errorResponse(403, "TIER_NONE",
      "타겟 적중률 60% 미만 — 열람 불가", req, env);
  }

  if (viewer.points < price) {
    return errorResponse(400, "INSUFFICIENT_POINTS",
      `필요 ${price}점, 보유 ${viewer.points}점`, req, env);
  }

  const refund = Math.floor(price * REFUND_RATIO);
  const ts = nowUnix();

  // 트랜잭션 — 결제 + 환원 + ledger
  await env.DB.batch([
    env.DB.prepare(`
      INSERT INTO bet_reveals (viewer_user_id, target_user_id, target_date,
                               cost, refund, revealed_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `).bind(viewer.id, targetUserId, targetDate, price, refund, ts),

    // viewer 차감
    env.DB.prepare(`UPDATE users SET points = points - ? WHERE id = ?`)
      .bind(price, viewer.id),

    // target 환원 (HoF 사용자에게 50%)
    env.DB.prepare(`UPDATE users SET points = points + ? WHERE id = ?`)
      .bind(refund, targetUserId),

    // ledger 기록 — viewer
    env.DB.prepare(`
      INSERT INTO points_ledger (user_id, delta, reason, ref_id, balance_after, ts)
      VALUES (?, ?, 'REVEAL_PAID', ?, ?, ?)
    `).bind(viewer.id, -price, `${targetUserId}:${targetDate}`,
            viewer.points - price, ts),

    // ledger 기록 — target
    env.DB.prepare(`
      INSERT INTO points_ledger (user_id, delta, reason, ref_id, balance_after, ts)
      SELECT id, ?, 'REVEAL_EARNED', ?, points, ?
      FROM users WHERE id = ?
    `).bind(refund, `${viewer.id}:${targetDate}`, ts, targetUserId),
  ]);

  return await respondWithBets(env, targetUserId, targetDate, viewer.id, req, {
    paid: price,
    target_earned: refund,
  });
}

/**
 * 베팅 내용 응답.
 */
async function respondWithBets(
  env: Env, targetUserId: string, targetDate: string,
  viewerId: string, req: Request,
  payInfo?: { paid: number; target_earned: number },
): Promise<Response> {
  // target의 해당 date 베팅 모두 조회 (UP/DOWN 만, PASS 제외)
  const result = await env.DB.prepare(`
    SELECT ticker, ticker_name, direction, amount, baseline_price,
           settled, outcome, actual_price, actual_change_pct
    FROM bets
    WHERE user_id = ? AND target_date = ? AND direction IN ('UP','DOWN')
    ORDER BY bet_at
  `).bind(targetUserId, targetDate).all();

  // 타겟 닉네임
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

/**
 * GET /api/reveals/:target_user_id/:date
 */
export async function handleGetReveal(
  req: Request, env: Env, targetUserId: string, targetDate: string,
): Promise<Response> {
  const viewer = await getCurrentUser(req, env);
  if (!viewer) {
    return errorResponse(401, "NO_SESSION", "쿠키 없음", req, env);
  }

  // 본인 베팅이면 무료 열람
  if (targetUserId === viewer.id) {
    return await respondWithBets(env, targetUserId, targetDate, viewer.id, req);
  }

  // 정산 후라면 무료
  const holidays = getActiveHolidaySet();
  const today = todayKST();
  if (targetDate < today) {
    return await respondWithBets(env, targetUserId, targetDate, viewer.id, req);
  }

  // 결제 기록 확인
  const paid = await env.DB.prepare(`
    SELECT cost FROM bet_reveals
    WHERE viewer_user_id = ? AND target_user_id = ? AND target_date = ?
  `).bind(viewer.id, targetUserId, targetDate).first<{ cost: number }>();

  if (!paid) {
    return errorResponse(402, "PAYMENT_REQUIRED",
      "결제 후 열람 가능. POST /api/reveals 사용.", req, env);
  }

  return await respondWithBets(env, targetUserId, targetDate, viewer.id, req);
}

/**
 * GET /api/me/reveals?limit=20
 */
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
