/**
 * Yahoo Finance API 직접 호출 (yfinance Python 라이브러리 대체).
 *
 * API: https://query1.finance.yahoo.com/v8/finance/chart/<symbol>?interval=1d&range=5d
 * - 인증 불필요, public
 * - rate limit 명시 안 됨 (관행상 ~100req/min/IP 권장)
 * - User-Agent 필수 (없으면 종종 403)
 */
import type { Env } from "../types";
import { nowUnix } from "./kst";

const YAHOO_BASE = "https://query1.finance.yahoo.com/v8/finance/chart";
const USER_AGENT = "Mozilla/5.0 (compatible; kospi-bets/1.0)";

export interface YahooClose {
  status: "OK" | "VOID" | "FAIL";
  close: number | null;
  volume: number | null;
  data_date: string | null;  // YYYY-MM-DD (마지막 유효 거래일)
  error?: string;
}

/**
 * 단일 종목 최근 종가 조회.
 *
 * VOID: 거래정지, 종가 null, 거래량 0 (정산 시 환불 처리)
 * FAIL: 네트워크 오류 (재시도 대상)
 * OK:   정상
 */
export async function fetchYahooClose(tickerCode: string): Promise<YahooClose> {
  const url = `${YAHOO_BASE}/${tickerCode}.KS?interval=1d&range=5d`;

  try {
    const res = await fetch(url, {
      headers: { "User-Agent": USER_AGENT, Accept: "application/json" },
      // Workers 안에서 외부 fetch는 자동 timeout 30s. 더 빨리 잘리는 게 안전.
      signal: AbortSignal.timeout(8000),
    });

    if (!res.ok) {
      return { status: "FAIL", close: null, volume: null, data_date: null,
               error: `HTTP_${res.status}` };
    }

    const data = await res.json() as any;
    const result = data?.chart?.result?.[0];
    if (!result) {
      return { status: "FAIL", close: null, volume: null, data_date: null,
               error: "NO_RESULT" };
    }

    const timestamps: number[] = result.timestamp || [];
    const closes: (number | null)[] = result.indicators?.quote?.[0]?.close || [];
    const volumes: (number | null)[] = result.indicators?.quote?.[0]?.volume || [];

    if (timestamps.length === 0) {
      return { status: "VOID", close: null, volume: null, data_date: null,
               error: "EMPTY_TIMESTAMPS" };
    }

    // 마지막 유효 인덱스 찾기 (null close 제외)
    let idx = timestamps.length - 1;
    while (idx >= 0 && (closes[idx] == null || (closes[idx] as number) <= 0)) {
      idx--;
    }
    if (idx < 0) {
      return { status: "VOID", close: null, volume: null, data_date: null,
               error: "ALL_NULL_CLOSES" };
    }

    const close = closes[idx] as number;
    const volume = volumes[idx] ?? 0;

    // 거래량 0 = 거래정지 의심
    if (volume === 0) {
      return { status: "VOID", close, volume: 0,
               data_date: new Date(timestamps[idx] * 1000).toISOString().slice(0, 10),
               error: "ZERO_VOLUME" };
    }

    return {
      status: "OK",
      close,
      volume,
      data_date: new Date(timestamps[idx] * 1000).toISOString().slice(0, 10),
    };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return { status: "FAIL", close: null, volume: null, data_date: null, error: msg };
  }
}

/**
 * 캐시 우선 종가 조회.
 *   1) closing_prices 테이블에 해당 (ticker, date) 있으면 즉시 반환
 *   2) 없으면 Yahoo 호출 → DB 캐시 → 반환
 */
export async function getClose(
  env: Env, tickerCode: string, date: string,
): Promise<YahooClose> {
  const cached = await env.DB.prepare(
    "SELECT close, volume FROM closing_prices WHERE ticker = ? AND date = ?"
  ).bind(tickerCode, date).first<{ close: number; volume: number }>();

  if (cached) {
    return { status: "OK", close: cached.close, volume: cached.volume,
             data_date: date };
  }

  // 캐시 미스 → Yahoo 호출
  const fresh = await fetchYahooClose(tickerCode);
  if (fresh.status === "OK" && fresh.close !== null && fresh.data_date === date) {
    // 캐시 저장 (await 안 함 — fire and forget)
    env.DB.prepare(`
      INSERT OR REPLACE INTO closing_prices (ticker, date, close, volume, fetched_at, source)
      VALUES (?, ?, ?, ?, ?, 'yahoo')
    `).bind(tickerCode, date, fresh.close, fresh.volume ?? 0, nowUnix()).run()
      .catch(() => {});
  }

  return fresh;
}

/**
 * 베팅 기준가 (가장 최근 거래일 종가).
 * 캐시 키는 fresh.data_date (Yahoo가 알려준 실제 거래일) 로 저장.
 */
export async function getBaselinePrice(env: Env, tickerCode: string): Promise<YahooClose> {
  const fresh = await fetchYahooClose(tickerCode);
  if (fresh.status === "OK" && fresh.close !== null && fresh.data_date !== null) {
    env.DB.prepare(`
      INSERT OR REPLACE INTO closing_prices (ticker, date, close, volume, fetched_at, source)
      VALUES (?, ?, ?, ?, ?, 'yahoo')
    `).bind(tickerCode, fresh.data_date, fresh.close, fresh.volume ?? 0, nowUnix()).run()
      .catch(() => {});
  }
  return fresh;
}
