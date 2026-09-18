/**
 * 일별 방문자 카운터. KST 기준 날짜별로 리셋되는 순수 카운터.
 * 브라우저당 하루 1회만 카운트되도록 클라이언트가 localStorage 로 dedup 하고,
 * 서버는 (date, dedup_key) unique 제약으로 이중 방어.
 */
import type { Env } from "../types";
import { jsonResponse, errorResponse } from "../lib/responses";
import { todayKST } from "../lib/kst";

export async function handleTrackVisit(req: Request, env: Env): Promise<Response> {
  let body: { visitor_id?: string };
  try {
    body = await req.json();
  } catch {
    return errorResponse(400, "BAD_REQUEST", "invalid JSON body", req, env);
  }

  const visitorId = (body.visitor_id || "").slice(0, 64);
  if (!visitorId) {
    return errorResponse(400, "BAD_REQUEST", "visitor_id required", req, env);
  }

  const date = todayKST();

  try {
    await env.DB.prepare(
      `INSERT INTO daily_visits (date, visitor_id) VALUES (?, ?)
       ON CONFLICT (date, visitor_id) DO NOTHING`
    ).bind(date, visitorId).run();
  } catch (err) {
    console.error("track visit failed:", err);
  }

  const row = await env.DB.prepare(
    `SELECT COUNT(*) AS cnt FROM daily_visits WHERE date = ?`
  ).bind(date).first<{ cnt: number }>();

  return jsonResponse({ date, count: row?.cnt ?? 0 }, {}, req, env);
}

export async function handleGetVisitCount(req: Request, env: Env): Promise<Response> {
  const date = todayKST();
  const row = await env.DB.prepare(
    `SELECT COUNT(*) AS cnt FROM daily_visits WHERE date = ?`
  ).bind(date).first<{ cnt: number }>();

  return jsonResponse({ date, count: row?.cnt ?? 0 }, {}, req, env);
}
