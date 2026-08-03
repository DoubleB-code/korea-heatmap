/**
 * 익명 사용자 인증 — HTTPOnly 쿠키 기반.
 *
 * 보안 고려사항:
 *   - 쿠키는 HttpOnly + Secure + SameSite=Lax
 *   - user_id 는 UUID v4 (256 bit 엔트로피)
 *   - HMAC 서명까지 가는 건 D3 단계에서 과잉 — 이 단계에선 그냥 UUID
 *   - 도메인 분리(API 도메인 ≠ 프론트 도메인) 시 SameSite=None + Secure 필수
 */
import type { Env, User } from "../types";
import { nowUnix } from "./kst";

const COOKIE_NAME = "kh_uid";
const COOKIE_MAX_AGE = 60 * 60 * 24 * 365;  // 1년

/** UUID v4 생성 */
export function generateUuid(): string {
  return crypto.randomUUID();
}

/** Cookie 헤더에서 user_id 추출 */
export function getUserIdFromCookie(req: Request): string | null {
  const cookieHeader = req.headers.get("Cookie") || "";
  const match = cookieHeader.match(new RegExp(`(?:^|;\\s*)${COOKIE_NAME}=([a-f0-9-]+)`));
  return match ? match[1] : null;
}

/** Set-Cookie 헤더 생성 (cross-site 대비 SameSite=None + Secure) */
export function buildSetCookieHeader(userId: string, env: Env): string {
  const parts = [
    `${COOKIE_NAME}=${userId}`,
    `Max-Age=${COOKIE_MAX_AGE}`,
    `Path=/`,
    `HttpOnly`,
    `Secure`,
    `SameSite=None`,
  ];
  // domain 명시 시 같은 부모 도메인에서 공유 가능
  // workers.dev 같은 공개 도메인은 cookie domain 설정 불가 — env 따라 분기
  if (env.COOKIE_DOMAIN && !env.COOKIE_DOMAIN.endsWith(".workers.dev")) {
    parts.push(`Domain=${env.COOKIE_DOMAIN}`);
  }
  return parts.join("; ");
}

/**
 * 닉네임 자동생성 (형용사 + 동물 + 숫자).
 * 진짜 운영 시엔 욕설/금칙어 필터 추가.
 */
const ADJECTIVES = [
  "현명한", "용감한", "냉정한", "꼼꼼한", "대담한", "신중한", "예리한",
  "민첩한", "느긋한", "치밀한", "강인한", "성실한", "유쾌한", "조용한",
  "노련한", "재빠른", "신비한", "정직한", "겸손한", "단호한",
];
const ANIMALS = [
  "두꺼비", "여우", "올빼미", "거북이", "수달", "까마귀", "고양이",
  "표범", "사슴", "독수리", "다람쥐", "늑대", "코끼리", "팬더",
  "오소리", "스라소니", "수리부엉이", "산양", "황새", "기린",
];

export function generateNickname(): string {
  const adj = ADJECTIVES[Math.floor(Math.random() * ADJECTIVES.length)];
  const animal = ANIMALS[Math.floor(Math.random() * ANIMALS.length)];
  const num = Math.floor(Math.random() * 1000);
  return `${adj} ${animal} ${num}`;
}

/**
 * 현재 사용자 조회. 쿠키 없으면 null. 있는데 DB에 없어도 null.
 */
export async function getCurrentUser(req: Request, env: Env): Promise<User | null> {
  const userId = getUserIdFromCookie(req);
  if (!userId) return null;

  const row = await env.DB
    .prepare("SELECT * FROM users WHERE id = ? AND banned = 0")
    .bind(userId)
    .first<User>();

  if (!row) return null;

  // last_seen 갱신 (백그라운드, await X)
  env.DB.prepare("UPDATE users SET last_seen_at = ? WHERE id = ?")
    .bind(nowUnix(), userId)
    .run()
    .catch(() => {});

  return row;
}

/**
 * IP 해시 (rate limit 키용). 원본 IP는 저장하지 않음 — privacy.
 */
export async function hashIp(ip: string): Promise<string> {
  const data = new TextEncoder().encode(ip + ":kh-salt-v1");
  const buf = await crypto.subtle.digest("SHA-256", data);
  return Array.from(new Uint8Array(buf))
    .slice(0, 8)
    .map(b => b.toString(16).padStart(2, "0"))
    .join("");
}
