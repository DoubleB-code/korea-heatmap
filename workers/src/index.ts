/**
 * KOSPI 예측 게임 API — Cloudflare Workers entry point.
 *
 * 라우트:
 *   GET  /api/health            - 헬스체크
 *   POST /api/user/init         - 익명 사용자 생성/복귀
 *   GET  /api/me                - 내 정보
 *   GET  /api/me/history        - 내 베팅 이력
 *   GET  /api/bets/today        - 오늘 추첨 종목 (결정적)
 *   POST /api/bets              - 베팅 제출
 *   GET  /api/leaderboard       - 리더보드
 */
import type { Env } from "./types";
import { handleOptions, jsonResponse, errorResponse } from "./lib/responses";
import {
  handleUserInit, handleMe, handleMyHistory, handleSetPrivacy,
} from "./handlers/user";
import { handleGetToday, handleSubmitBet } from "./handlers/bets";
import { handleLeaderboard } from "./handlers/leaderboard";
import { handleHof, handleUserProfile } from "./handlers/hof";
import {
  handleSubmitReveal, handleGetReveal, handleMyReveals,
} from "./handlers/reveals";
import { runSettlement } from "./handlers/settle";

export default {
  async fetch(req: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    if (req.method === "OPTIONS") {
      return handleOptions(req, env);
    }

    const url = new URL(req.url);
    const path = url.pathname;
    const method = req.method;

    try {
      // 헬스체크
      if (path === "/api/health") {
        return jsonResponse({ ok: true, ts: Date.now() }, {}, req, env);
      }

      // User APIs
      if (path === "/api/user/init" && method === "POST") {
        return await handleUserInit(req, env);
      }
      if (path === "/api/me" && method === "GET") {
        return await handleMe(req, env);
      }
      if (path === "/api/me/history" && method === "GET") {
        return await handleMyHistory(req, env);
      }

      // Bets APIs
      if (path === "/api/bets/today" && method === "GET") {
        return await handleGetToday(req, env);
      }
      if (path === "/api/bets" && method === "POST") {
        return await handleSubmitBet(req, env);
      }

      // Leaderboard
      if (path === "/api/leaderboard" && method === "GET") {
        return await handleLeaderboard(req, env);
      }

      // Privacy 토글
      if (path === "/api/me/privacy" && method === "PATCH") {
        return await handleSetPrivacy(req, env);
      }

      // 명예의 전당
      if (path === "/api/hof" && method === "GET") {
        return await handleHof(req, env);
      }

      // 공개 프로필
      const profileMatch = path.match(/^\/api\/users\/([^/]+)\/profile$/);
      if (profileMatch && method === "GET") {
        return await handleUserProfile(req, env, profileMatch[1]);
      }

      // 베팅 열람 시장
      if (path === "/api/reveals" && method === "POST") {
        return await handleSubmitReveal(req, env);
      }
      if (path === "/api/me/reveals" && method === "GET") {
        return await handleMyReveals(req, env);
      }
      const revealMatch = path.match(/^\/api\/reveals\/([^/]+)\/(\d{4}-\d{2}-\d{2})$/);
      if (revealMatch && method === "GET") {
        return await handleGetReveal(req, env, revealMatch[1], revealMatch[2]);
      }

      return errorResponse(404, "NOT_FOUND",
        `${method} ${path} not found`, req, env);

    } catch (err) {
      console.error("Unhandled error:", err);
      const msg = err instanceof Error ? err.message : String(err);
      return errorResponse(500, "INTERNAL_ERROR", msg, req, env);
    }
  },

  // Cron 정산 — 매일 17:30 KST (wrangler.toml triggers.crons)
  async scheduled(event: ScheduledEvent, env: Env, ctx: ExecutionContext) {
    console.log("[CRON] settlement start:", event.cron, new Date().toISOString());
    try {
      const result = await runSettlement(env);
      console.log("[CRON] settlement done:", JSON.stringify(result));
    } catch (err) {
      console.error("[CRON] settlement error:", err);
    }
  },
} satisfies ExportedHandler<Env>;
