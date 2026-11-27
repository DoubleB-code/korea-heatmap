import type { Env, User } from "../types";
import {
  buildSetCookieHeader,
  generateNickname,
  generateUuid,
  getUserIdFromCookie,
} from "../lib/auth";
import { errorResponse } from "../lib/responses";
import { nowUnix } from "../lib/kst";

type Provider = "google" | "kakao";

const STATE_TTL_SEC = 600;

export async function handleAuthStart(
  req: Request,
  env: Env,
  provider: Provider,
): Promise<Response> {
  const migrationReady = await hasOauthTables(env);
  if (!migrationReady) {
    return errorResponse(503, "MIGRATION_PENDING", "마이그레이션 0002 적용 필요", req, env);
  }

  const cfg = getProviderConfig(env, provider);
  const needsSecret = provider === "google";
  if (!cfg.clientId || (needsSecret && !cfg.clientSecret)) {
    return errorResponse(503, "OAUTH_NOT_CONFIGURED", `${provider} OAuth secret 누락`, req, env);
  }

  const url = new URL(req.url);
  const returnTo = sanitizeReturnTo(url.searchParams.get("return_to"), env);
  const state = crypto.randomUUID().replace(/-/g, "");
  const currentUid = getUserIdFromCookie(req);
  const createdAt = nowUnix();

  await env.DB.prepare(
    `INSERT INTO oauth_state (state, current_uid, created_at, return_url)
     VALUES (?, ?, ?, ?)`
  ).bind(state, currentUid, createdAt, returnTo).run();

  const redirectUri = `${url.origin}/api/auth/${provider}/callback`;
  const authUrl = buildAuthorizeUrl(provider, cfg.clientId, redirectUri, state);
  return Response.redirect(authUrl, 302);
}

export async function handleAuthCallback(
  req: Request,
  env: Env,
  provider: Provider,
): Promise<Response> {
  const migrationReady = await hasOauthTables(env);
  if (!migrationReady) {
    return errorResponse(503, "MIGRATION_PENDING", "마이그레이션 0002 적용 필요", req, env);
  }

  const url = new URL(req.url);
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  const error = url.searchParams.get("error");

  if (error) {
    return redirectWithStatus(sanitizeReturnTo(null, env), `login_error=${encodeURIComponent(error)}`);
  }
  if (!code || !state) {
    return errorResponse(400, "INVALID_CALLBACK", "code/state 누락", req, env);
  }

  const stateRow = await env.DB.prepare(
    `SELECT state, current_uid, created_at, return_url
     FROM oauth_state WHERE state = ?`
  ).bind(state).first<{ state: string; current_uid: string | null; created_at: number; return_url: string | null }>();

  if (!stateRow) {
    return errorResponse(400, "INVALID_STATE", "state가 유효하지 않음", req, env);
  }
  if (nowUnix() - stateRow.created_at > STATE_TTL_SEC) {
    await env.DB.prepare("DELETE FROM oauth_state WHERE state = ?").bind(state).run();
    return errorResponse(400, "STATE_EXPIRED", "state 만료", req, env);
  }

  const cfg = getProviderConfig(env, provider);
  const redirectUri = `${url.origin}/api/auth/${provider}/callback`;
  const profile = await exchangeCodeForProfile(provider, cfg, code, redirectUri);

  const userId = await attachOauthUser(env, {
    provider,
    externalId: profile.externalId,
    displayName: profile.displayName,
    avatarUrl: profile.avatarUrl,
    currentUid: stateRow.current_uid,
  });

  await env.DB.prepare("DELETE FROM oauth_state WHERE state = ?").bind(state).run();

  const res = redirectWithStatus(
    sanitizeReturnTo(stateRow.return_url, env),
    `login_success=${provider}`,
  );
  res.headers.set("Set-Cookie", buildSetCookieHeader(userId, env));
  return res;
}

function getProviderConfig(env: Env, provider: Provider) {
  if (provider === "google") {
    return {
      clientId: env.GOOGLE_CLIENT_ID || "",
      clientSecret: env.GOOGLE_CLIENT_SECRET || "",
    };
  }
  return {
    clientId: env.KAKAO_CLIENT_ID || "",
    clientSecret: env.KAKAO_CLIENT_SECRET || "",
  };
}

function allowedOrigins(env: Env): string[] {
  return (env.ALLOWED_ORIGINS || "")
    .split(",")
    .map(s => s.trim())
    .filter(Boolean);
}

function sanitizeReturnTo(raw: string | null, env: Env): string {
  const allowed = allowedOrigins(env);
  const fallback = `${allowed[0] || "https://koreaheatmap.com"}/bet.html`;
  if (!raw) return fallback;
  try {
    const url = new URL(raw);
    if (allowed.includes(url.origin)) return raw;
  } catch {}
  return fallback;
}

function redirectWithStatus(returnTo: string, query: string): Response {
  const dest = new URL(returnTo);
  const [key, value] = query.split("=");
  dest.searchParams.set(key, value || "1");
  return Response.redirect(dest.toString(), 302);
}

function buildAuthorizeUrl(
  provider: Provider,
  clientId: string,
  redirectUri: string,
  state: string,
): string {
  if (provider === "google") {
    const u = new URL("https://accounts.google.com/o/oauth2/v2/auth");
    u.searchParams.set("client_id", clientId);
    u.searchParams.set("redirect_uri", redirectUri);
    u.searchParams.set("response_type", "code");
    u.searchParams.set("scope", "openid email profile");
    u.searchParams.set("prompt", "select_account");
    u.searchParams.set("state", state);
    return u.toString();
  }

  const u = new URL("https://kauth.kakao.com/oauth/authorize");
  u.searchParams.set("client_id", clientId);
  u.searchParams.set("redirect_uri", redirectUri);
  u.searchParams.set("response_type", "code");
  u.searchParams.set("state", state);
  return u.toString();
}

async function exchangeCodeForProfile(
  provider: Provider,
  cfg: { clientId: string; clientSecret: string },
  code: string,
  redirectUri: string,
): Promise<{ externalId: string; displayName: string; avatarUrl: string | null }> {
  if (provider === "google") {
    const tokenRes = await fetch("https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        code,
        client_id: cfg.clientId,
        client_secret: cfg.clientSecret,
        redirect_uri: redirectUri,
        grant_type: "authorization_code",
      }),
    });
    const tokenJson: any = await tokenRes.json();
    if (!tokenRes.ok || !tokenJson.access_token) {
      throw new Error(`google_token_failed:${JSON.stringify(tokenJson)}`);
    }
    const meRes = await fetch("https://www.googleapis.com/oauth2/v3/userinfo", {
      headers: { Authorization: `Bearer ${tokenJson.access_token}` },
    });
    const me: any = await meRes.json();
    if (!meRes.ok || !me.sub) {
      throw new Error(`google_me_failed:${JSON.stringify(me)}`);
    }
    return {
      externalId: String(me.sub),
      displayName: String(me.name || me.email || "Google 사용자"),
      avatarUrl: me.picture ? String(me.picture) : null,
    };
  }

  const tokenBody = new URLSearchParams({
    grant_type: "authorization_code",
    client_id: cfg.clientId,
    redirect_uri: redirectUri,
    code,
  });
  if (cfg.clientSecret) tokenBody.set("client_secret", cfg.clientSecret);

  const tokenRes = await fetch("https://kauth.kakao.com/oauth/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded;charset=utf-8" },
    body: tokenBody,
  });
  const tokenJson: any = await tokenRes.json();
  if (!tokenRes.ok || !tokenJson.access_token) {
    throw new Error(`kakao_token_failed:${JSON.stringify(tokenJson)}`);
  }

  const meRes = await fetch("https://kapi.kakao.com/v2/user/me", {
    headers: { Authorization: `Bearer ${tokenJson.access_token}` },
  });
  const me: any = await meRes.json();
  if (!meRes.ok || !me.id) {
    throw new Error(`kakao_me_failed:${JSON.stringify(me)}`);
  }

  const nickname = me.kakao_account?.profile?.nickname || `카카오 사용자 ${me.id}`;
  const avatar = me.kakao_account?.profile?.profile_image_url || null;
  return {
    externalId: String(me.id),
    displayName: String(nickname),
    avatarUrl: avatar ? String(avatar) : null,
  };
}

async function attachOauthUser(
  env: Env,
  input: {
    provider: Provider;
    externalId: string;
    displayName: string;
    avatarUrl: string | null;
    currentUid: string | null;
  },
): Promise<string> {
  const linked = await env.DB.prepare(
    `SELECT * FROM users WHERE auth_provider = ? AND auth_external_id = ? AND banned = 0`
  ).bind(input.provider, input.externalId).first<User>();

  const ts = nowUnix();
  if (linked) {
    await env.DB.prepare(
      `UPDATE users
       SET display_name = ?, avatar_url = ?, last_seen_at = ?
       WHERE id = ?`
    ).bind(input.displayName, input.avatarUrl, ts, linked.id).run();
    return linked.id;
  }

  if (input.currentUid) {
    const current = await env.DB.prepare(
      `SELECT * FROM users WHERE id = ? AND banned = 0`
    ).bind(input.currentUid).first<User>();

    if (current && (!current.auth_provider || current.auth_provider === "anon")) {
      await env.DB.prepare(
        `UPDATE users
         SET auth_provider = ?, auth_external_id = ?, display_name = ?, avatar_url = ?, last_seen_at = ?
         WHERE id = ?`
      ).bind(
        input.provider,
        input.externalId,
        input.displayName,
        input.avatarUrl,
        ts,
        current.id,
      ).run();
      return current.id;
    }
  }

  const userId = generateUuid();
  const initialPoints = parseInt(env.INITIAL_POINTS, 10) || 1000;
  await env.DB.prepare(
    `INSERT INTO users (
      id, nickname, created_at, last_seen_at, points,
      auth_provider, auth_external_id, display_name, avatar_url, bets_public
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1)`
  ).bind(
    userId,
    generateNickname(),
    ts,
    ts,
    initialPoints,
    input.provider,
    input.externalId,
    input.displayName,
    input.avatarUrl,
  ).run();

  return userId;
}

async function hasOauthTables(env: Env): Promise<boolean> {
  const col = await env.DB.prepare(
    "SELECT name FROM pragma_table_info('users') WHERE name = 'auth_provider'"
  ).first<{ name: string }>();
  return !!col;
}
