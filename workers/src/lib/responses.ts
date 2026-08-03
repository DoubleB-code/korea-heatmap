/**
 * JSON 응답 헬퍼 + CORS 처리.
 */
import type { Env } from "../types";

function corsHeaders(req: Request, env: Env): HeadersInit {
  const origin = req.headers.get("Origin") || "";
  const allowed = env.ALLOWED_ORIGINS.split(",").map(s => s.trim()).filter(Boolean);
  const allow = allowed.includes(origin) ? origin : allowed[0] || origin || "*";

  return {
    "Access-Control-Allow-Origin": allow,
    "Access-Control-Allow-Credentials": "true",
    "Access-Control-Allow-Methods": "GET, POST, PATCH, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, X-CSRF-Token",
    "Access-Control-Max-Age": "86400",
    "Vary": "Origin",
  };
}

export function jsonResponse(
  data: unknown,
  init: ResponseInit = {},
  req?: Request,
  env?: Env,
): Response {
  const headers: HeadersInit = {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    ...(init.headers || {}),
  };
  if (req && env) {
    Object.assign(headers, corsHeaders(req, env));
  }
  return new Response(JSON.stringify(data), { ...init, headers });
}

export function errorResponse(
  status: number,
  code: string,
  message: string,
  req?: Request,
  env?: Env,
): Response {
  return jsonResponse({ error: { code, message } }, { status }, req, env);
}

export function handleOptions(req: Request, env: Env): Response {
  return new Response(null, {
    status: 204,
    headers: corsHeaders(req, env),
  });
}
