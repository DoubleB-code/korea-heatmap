/**
 * 베팅 API.
 */
import type { Env, Direction } from "../types";
import { getCurrentUser, hashIp } from "../lib/auth";
import { jsonResponse, errorResponse } from "../lib/responses";
import { todayKST, nowUnix, nextBusinessDay } from "../lib/kst";
import { getCurrentUniverse, pickStock } from "../lib/top30";
import { getBaselinePrice } from "../lib/yahoo";
import { getActiveHolidaySet } from "../lib/holidays";

const IP_DAILY_BET_LIMIT = 30;

export async function handleGetToday(req: Request, env: Env): Promise<Response> {
  const user = await getCurrentUser(req, env);
  if (!user) {
    return errorResponse(401, "NO_SESSION", "쿠키 없음", req, env);
  }

  const url = new URL(req.url);
  const today = todayKST();
  const dailyLimit = parseInt(env.DAILY_BET_LIMIT, 10) || 3;

  const quotaRow = await env.DB
    .prepare("SELECT count FROM daily_bet_count WHERE user_id = ? AND date = ?")
    .bind(user.id, today)
    .first<{ count: number }>();
  const usedToday = quotaRow?.count || 0;

  const seqParam = url.searchParams.get("seq");
  const seq = seqParam !== null ? parseInt(seqParam, 10) : usedToday;
  if (isNaN(seq) || seq < 0 || seq >= dailyLimit) {
    return errorResponse(400, "INVALID_SEQ", `seq must be 0..${dailyLimit - 1}`, req, env);
  }

  const universe = await getCurrentUniverse(env);
  if (universe.length === 0) {
    return errorResponse(503, "NO_UNIVERSE", "TOP30 데이터 미설정", req, env);
  }

  const holidays = getActiveHolidaySet();
  const targetDate = nextBusinessDay(holidays);
  const stock = await pickStock(user.id, targetDate, seq, universe);

  const price = await getBaselinePrice(env, stock.code);
  if (price.status !== "OK" || price.close === null) {
    return jsonResponse({
      stock,
      baseline_price: null,
      target_date: targetDate,
      seq,
      warning: `price_unavailable: ${price.error}`,
    }, {}, req, env);
  }

  return jsonResponse({
    stock,
    baseline_price: price.close,
    baseline_date: price.data_date,
    target_date: targetDate,
    seq,
    today: { used: usedToday, limit: dailyLimit, remaining: dailyLimit - usedToday },
  }, {}, req, env);
}

export async function handleSubmitBet(req: Request, env: Env): Promise<Response> {
  const user = await getCurrentUser(req, env);
  if (!user) {
    return errorResponse(401, "NO_SESSION", "쿠키 없음", req, env);
  }
  if (((user as any).auth_provider || "anon") === "anon") {
    return errorResponse(401, "AUTH_REQUIRED", "예측 기록 저장은 구글 또는 카카오 로그인 후 가능합니다.", req, env);
  }

  let body: any;
  try {
    body = await req.json();
  } catch {
    return errorResponse(400, "INVALID_JSON", "JSON 파싱 실패", req, env);
  }

  const direction = body.direction as Direction | "PASS";
  const amount = parseInt(body.amount, 10);
  const reqSeq = parseInt(body.seq, 10);

  if (!["UP", "DOWN", "PASS"].includes(direction)) {
    return errorResponse(400, "INVALID_DIRECTION", "direction은 UP/DOWN/PASS 만 가능", req, env);
  }

  const minBet = parseInt(env.MIN_BET, 10) || 10;
  const maxBet = parseInt(env.MAX_BET, 10) || 100;
  if (direction === "PASS") {
    if (amount !== 0) {
      return errorResponse(400, "INVALID_AMOUNT", "PASS는 amount=0", req, env);
    }
  } else if (isNaN(amount) || amount < minBet || amount > maxBet) {
    return errorResponse(400, "INVALID_AMOUNT", `amount는 ${minBet} 이상 ${maxBet} 이하`, req, env);
  }

  const today = todayKST();
  const dailyLimit = parseInt(env.DAILY_BET_LIMIT, 10) || 3;

  const quotaRow = await env.DB
    .prepare("SELECT count FROM daily_bet_count WHERE user_id = ? AND date = ?")
    .bind(user.id, today)
    .first<{ count: number }>();
  const usedToday = quotaRow?.count || 0;

  if (usedToday >= dailyLimit) {
    return errorResponse(429, "DAILY_LIMIT", "오늘 베팅 한도 소진", req, env);
  }
  if (!isNaN(reqSeq) && reqSeq !== usedToday) {
    return errorResponse(409, "SEQ_MISMATCH", `예상 seq=${usedToday}, 입력 seq=${reqSeq}`, req, env);
  }
  if (direction !== "PASS" && user.points < amount) {
    return errorResponse(400, "INSUFFICIENT_POINTS", `현재 점수 ${user.points} < 베팅액 ${amount}`, req, env);
  }

  const ip = req.headers.get("CF-Connecting-IP") || "0.0.0.0";
  const ipHash = await hashIp(ip);
  const ipRow = await env.DB
    .prepare("SELECT bet_submissions FROM ip_rate_limit WHERE ip_hash = ? AND date = ?")
    .bind(ipHash, today)
    .first<{ bet_submissions: number }>();
  if (ipRow && ipRow.bet_submissions >= IP_DAILY_BET_LIMIT) {
    return errorResponse(429, "IP_LIMIT", "이 네트워크 일일 베팅 한도 초과", req, env);
  }

  const universe = await getCurrentUniverse(env);
  if (universe.length === 0) {
    return errorResponse(503, "NO_UNIVERSE", "TOP30 데이터 미설정", req, env);
  }
  const holidays = getActiveHolidaySet();
  const targetDate = nextBusinessDay(holidays);
  const stock = await pickStock(user.id, targetDate, usedToday, universe);

  const price = await getBaselinePrice(env, stock.code);
  if (price.status !== "OK" || price.close === null) {
    return errorResponse(503, "PRICE_UNAVAILABLE", `기준가 조회 실패: ${price.error}`, req, env);
  }
  const baselinePrice = price.close;
  const now = nowUnix();

  const outcome = direction === "PASS" ? "VOID" : null;
  const settled = direction === "PASS" ? 1 : 0;
  const payout = direction === "PASS" ? 0 : null;

  await env.DB.batch([
    env.DB.prepare(`
      INSERT INTO bets (user_id, ticker, ticker_name, target_date, direction,
                        amount, baseline_price, bet_at, settled, outcome, payout)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).bind(user.id, stock.code, stock.name, targetDate, direction, amount, baselinePrice, now, settled, outcome, payout),
    env.DB.prepare(`
      UPDATE users SET
        points = points - ?,
        total_bets = total_bets + ?,
        total_voids = total_voids + ?,
        last_bet_date = ?,
        last_seen_at = ?
      WHERE id = ?
    `).bind(
      direction === "PASS" ? 0 : amount,
      direction === "PASS" ? 0 : 1,
      direction === "PASS" ? 1 : 0,
      today,
      now,
      user.id,
    ),
    env.DB.prepare(`
      INSERT INTO daily_bet_count (user_id, date, count)
      VALUES (?, ?, 1)
      ON CONFLICT(user_id, date) DO UPDATE SET count = count + 1
    `).bind(user.id, today),
    env.DB.prepare(`
      INSERT INTO ip_rate_limit (ip_hash, date, bet_submissions)
      VALUES (?, ?, 1)
      ON CONFLICT(ip_hash, date) DO UPDATE SET bet_submissions = bet_submissions + 1
    `).bind(ipHash, today),
  ]);

  return jsonResponse({
    bet: {
      ticker: stock.code,
      ticker_name: stock.name,
      direction,
      amount,
      baseline_price: baselinePrice,
      target_date: targetDate,
      seq: usedToday,
    },
    user: {
      points_after: user.points - (direction === "PASS" ? 0 : amount),
      today_remaining: dailyLimit - (usedToday + 1),
    },
    message: direction === "PASS"
      ? "PASS — 일일 한도 1회 차감"
      : `${stock.name} ${direction} ${amount}점 베팅 완료. ${targetDate} 종가 정산.`,
  }, {}, req, env);
}
