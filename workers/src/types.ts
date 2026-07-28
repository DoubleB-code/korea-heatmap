/**
 * Cloudflare Workers 환경 타입 정의.
 */
export interface Env {
  DB: D1Database;

  // vars (wrangler.toml [vars])
  ALLOWED_ORIGINS: string;
  COOKIE_DOMAIN: string;
  DAILY_BET_LIMIT: string;
  INITIAL_POINTS: string;
  MIN_BET: string;
  MAX_BET: string;
  DEAD_ZONE_PCT: string;
}

export interface User {
  id: string;
  nickname: string;
  created_at: number;
  last_seen_at: number;
  points: number;
  total_bets: number;
  total_wins: number;
  total_voids: number;
  streak_days: number;
  last_bet_date: string | null;
  banned: number;
}

export interface Bet {
  id: number;
  user_id: string;
  ticker: string;
  ticker_name: string;
  target_date: string;
  direction: "UP" | "DOWN" | "PASS";
  amount: number;
  baseline_price: number;
  bet_at: number;
  settled: number;
  outcome: "WIN" | "LOSE" | "VOID" | null;
  actual_price: number | null;
  actual_change_pct: number | null;
  payout: number | null;
  settled_at: number | null;
}

export interface Top30Stock {
  code: string;
  name: string;
  sector: string;
  value: number;
}

export type Direction = "UP" | "DOWN";
export type Outcome = "WIN" | "LOSE" | "VOID";
