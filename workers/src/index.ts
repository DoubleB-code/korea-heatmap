/**
 * KOSPI 예측 게임 API — Cloudflare Workers entry point.
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
import { handleAuthStart, handleAuthCallback } from "./handlers/oauth";
import { handleTrackVisit, handleGetVisitCount } from "./handlers/visits";
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
      if (path === "/api/health") {
        return jsonResponse({ ok: true, ts: Date.now() }, {}, req, env);
      }

      if (path === "/api/user/init" && method === "POST") {
        return await handleUserInit(req, env);
      }
      if (path === "/api/me" && method === "GET") {
        return await handleMe(req, env);
      }
      if (path === "/api/me/history" && method === "GET") {
        return await handleMyHistory(req, env);
      }
      if (path === "/api/me/privacy" && method === "PATCH") {
        return await handleSetPrivacy(req, env);
      }

      if (path === "/api/bets/today" && method === "GET") {
        return await handleGetToday(req, env);
      }
      if (path === "/api/bets" && method === "POST") {
        return await handleSubmitBet(req, env);
      }

      if (path === "/api/leaderboard" && method === "GET") {
        return await handleLeaderboard(req, env);
      }
      if (path === "/api/hof" && method === "GET") {
        return await handleHof(req, env);
      }

      if (path === "/api/visits" && method === "POST") {
        return await handleTrackVisit(req, env);
      }
      if (path === "/api/visits" && method === "GET") {
        return await handleGetVisitCount(req, env);
      }

      const authStartMatch = path.match(/^\/api\/auth\/(google|kakao)\/start$/);
      if (authStartMatch && method === "GET") {
        return await handleAuthStart(req, env, authStartMatch[1] as "google" | "kakao");
      }
      const authCallbackMatch = path.match(/^\/api\/auth\/(google|kakao)\/callback$/);
      if (authCallbackMatch && method === "GET") {
        return await handleAuthCallback(req, env, authCallbackMatch[1] as "google" | "kakao");
      }

      const profileMatch = path.match(/^\/api\/users\/([^/]+)\/profile$/);
      if (profileMatch && method === "GET") {
        return await handleUserProfile(req, env, profileMatch[1]);
      }

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

      return errorResponse(404, "NOT_FOUND", `${method} ${path} not found`, req, env);
    } catch (err) {
      console.error("Unhandled error:", err);
      const msg = err instanceof Error ? err.message : String(err);
      return errorResponse(500, "INTERNAL_ERROR", msg, req, env);
    }
  },

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
