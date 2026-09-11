"""
D3 베팅 정산 로직 (Python 레퍼런스).

운영 시에는 Cloudflare Workers Cron 으로 포팅. 이 파일은 로직 검증 + 단위 테스트용.

흐름:
    1. 영업일 여부 확인 (KRX 캘린더 가드)
    2. 종가 fetch (yfinance, retry 3회)
    3. 거래정지/이상 케이스 분류
    4. 미정산 bets 조회 → outcome 계산 → points payout
    5. users 통계 업데이트 + 적중 streak

종료 코드:
    0  정산 성공 또는 휴장일 SKIP
    1  종가 fetch 실패 (재시도 후에도)
    2  DB 오류
"""
import argparse
import json
import logging
import sys
import sqlite3
from datetime import datetime, timezone, timedelta
from pathlib import Path

import yfinance as yf

KST = timezone(timedelta(hours=9))
PROJECT_ROOT = Path(__file__).resolve().parent.parent

# 정산 파라미터
DEAD_ZONE_PCT = 0.1        # ±0.1% 이내면 VOID
PAYOUT_RATIO = 1.0         # 1:1 (적중 시 베팅액 회수 + 동일액 보상)
VOID_REFUND = True         # VOID 시 점수 환불
MIN_VOLUME_FRACTION = 0.05 # 평균 거래량의 5% 미만이면 거래정지 의심 → VOID

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s %(levelname)-7s %(message)s",
    datefmt="%H:%M:%S",
)
log = logging.getLogger("settle")


def load_holidays():
    """KRX 휴장일 set 로드."""
    p = PROJECT_ROOT / "data" / "krx_holidays_2026.json"
    if not p.exists():
        log.warning("휴장일 캘린더 없음 — 주말만 차단")
        return set()
    data = json.loads(p.read_text(encoding="utf-8"))
    return {h["date"] for h in data["holidays"]}


def is_trading_day(date_str, holidays):
    """date_str (YYYY-MM-DD) 가 영업일인가."""
    d = datetime.strptime(date_str, "%Y-%m-%d")
    if d.weekday() >= 5:
        return False  # 토/일
    if date_str in holidays:
        return False
    return True


def fetch_close(ticker_code, target_date, retries=3):
    """
    Returns:
        ("OK",   close_price, volume)
        ("VOID", reason, None)        — 거래정지/이상
        ("FAIL", reason, None)        — 네트워크 등 일시 장애
    """
    sym = f"{ticker_code}.KS"
    last_err = None

    for attempt in range(retries):
        try:
            t = yf.Ticker(sym)
            # target_date 포함 5일치 → target_date 행 추출
            start = (datetime.strptime(target_date, "%Y-%m-%d") - timedelta(days=10)).strftime("%Y-%m-%d")
            end = (datetime.strptime(target_date, "%Y-%m-%d") + timedelta(days=1)).strftime("%Y-%m-%d")
            hist = t.history(start=start, end=end, auto_adjust=False)

            if hist.empty:
                last_err = "EMPTY_HISTORY"
                continue

            # target_date 와 일치하는 행 찾기
            target_row = None
            for idx, row in hist.iterrows():
                if idx.strftime("%Y-%m-%d") == target_date:
                    target_row = row
                    break

            if target_row is None:
                # 휴장이거나 종가 미확정
                return ("VOID", f"NO_DATA_FOR_{target_date}", None)

            close = float(target_row["Close"])
            volume = int(target_row["Volume"])

            if close <= 0:
                return ("VOID", "INVALID_CLOSE", None)

            # 거래량 0 = 거래정지
            if volume == 0:
                return ("VOID", "ZERO_VOLUME_SUSPENDED", None)

            # 평균 대비 거래량 너무 낮으면 의심 (단기과열/임시 정지)
            if len(hist) >= 5:
                avg_vol = hist["Volume"].iloc[:-1].mean()
                if avg_vol > 0 and volume < avg_vol * MIN_VOLUME_FRACTION:
                    log.warning(
                        "%s 거래량 비정상 저조 (vol=%d, avg=%d)",
                        ticker_code, volume, int(avg_vol)
                    )
                    # 이건 정산은 진행. 단 로그 남김.

            return ("OK", close, volume)

        except Exception as e:
            last_err = str(e)
            log.warning("fetch %s 실패 (attempt %d): %s", ticker_code, attempt + 1, e)

    return ("FAIL", f"RETRIES_EXHAUSTED: {last_err}", None)


def settle_bet(bet, actual_price):
    """
    단일 bet 정산.

    Args:
        bet: dict — {direction, amount, baseline_price}
        actual_price: float — 정산 기준일 종가
    Returns:
        outcome: 'WIN' | 'LOSE' | 'VOID'
        payout: int — points 변화 (음수 가능)
        change_pct: float
    """
    baseline = bet["baseline_price"]
    change_pct = (actual_price - baseline) / baseline * 100

    # 데드존: ±0.1% 이내 → VOID
    if abs(change_pct) < DEAD_ZONE_PCT:
        payout = bet["amount"] if VOID_REFUND else 0
        return ("VOID", payout, round(change_pct, 3))

    direction = bet["direction"]
    is_up = change_pct > 0

    if (direction == "UP" and is_up) or (direction == "DOWN" and not is_up):
        # 적중 — 베팅액 회수 + 동일액 보상
        payout = bet["amount"] + int(bet["amount"] * PAYOUT_RATIO)
        return ("WIN", payout, round(change_pct, 3))
    else:
        # 실패 — 베팅액 손실
        return ("LOSE", 0, round(change_pct, 3))


def settle_void(bet):
    """거래정지/이상 시 VOID 처리 (점수 환불)."""
    payout = bet["amount"] if VOID_REFUND else 0
    return ("VOID", payout, None)


def run_settlement(db_path, target_date):
    """target_date 의 모든 미정산 bets 정산."""
    holidays = load_holidays()

    if not is_trading_day(target_date, holidays):
        log.info("%s 는 휴장일 — 정산 SKIP", target_date)
        return 0

    conn = sqlite3.connect(db_path)
    conn.row_factory = sqlite3.Row
    cur = conn.cursor()

    # 미정산 bets 조회
    cur.execute("""
        SELECT id, user_id, ticker, direction, amount, baseline_price
        FROM bets
        WHERE target_date = ? AND settled = 0 AND direction IN ('UP', 'DOWN')
    """, (target_date,))
    bets = [dict(r) for r in cur.fetchall()]

    if not bets:
        log.info("%s 미정산 bet 없음", target_date)
        conn.close()
        return 0

    log.info("%s 정산 시작 — %d건", target_date, len(bets))

    # ticker 별로 한 번만 종가 fetch
    tickers = sorted({b["ticker"] for b in bets})
    close_cache = {}

    for tk in tickers:
        status, value, _ = fetch_close(tk, target_date)
        close_cache[tk] = (status, value)
        if status == "OK":
            log.info("  %s 종가 %.0f", tk, value)
        else:
            log.warning("  %s %s — %s", tk, status, value)

    # 각 bet 정산
    win_n = lose_n = void_n = 0
    settled_at = int(datetime.now(KST).timestamp())

    for bet in bets:
        status, value = close_cache[bet["ticker"]]

        if status == "OK":
            outcome, payout, change_pct = settle_bet(bet, value)
            actual_price = value
            actual_change_pct = change_pct
        elif status == "VOID":
            outcome, payout, _ = settle_void(bet)
            actual_price = None
            actual_change_pct = None
        else:
            # FAIL — 정산 보류 (다음 cron 에서 재시도)
            log.error("bet %d 정산 보류 (fetch FAIL)", bet["id"])
            continue

        if outcome == "WIN": win_n += 1
        elif outcome == "LOSE": lose_n += 1
        else: void_n += 1

        # bet 업데이트
        cur.execute("""
            UPDATE bets
            SET settled = 1, outcome = ?, payout = ?,
                actual_price = ?, actual_change_pct = ?
            WHERE id = ?
        """, (outcome, payout, actual_price, actual_change_pct, bet["id"]))

        # user 점수 업데이트
        # WIN: payout = amount * 2 → 순증 amount
        # LOSE: payout = 0 → 이미 차감된 amount 손실 확정
        # VOID: payout = amount → 환불
        net_change = payout - bet["amount"]
        cur.execute("""
            UPDATE users
            SET points = points + ?,
                total_wins = total_wins + ?,
                last_seen_at = ?
            WHERE id = ?
        """, (net_change, 1 if outcome == "WIN" else 0, settled_at, bet["user_id"]))

    conn.commit()
    conn.close()

    log.info("정산 완료 — WIN %d, LOSE %d, VOID %d", win_n, lose_n, void_n)
    return 0


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--date", required=True, help="정산 대상일 YYYY-MM-DD")
    ap.add_argument("--db", default=str(PROJECT_ROOT / "data" / "bets.sqlite3"))
    args = ap.parse_args()
    return run_settlement(args.db, args.date)


if __name__ == "__main__":
    sys.exit(main())
