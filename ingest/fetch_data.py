"""
KOSPI 200 일별 스냅샷 수집 (yfinance / Yahoo Finance 기반).

PyKRX -> FinanceDataReader -> yfinance 전환 이력:
- PyKRX: KRX가 GitHub Actions IP를 차단해서 작동 불가
- FinanceDataReader: 한국 종목에 대해 내부적으로 KRX/Naver fchart 호출 -> 동일 차단 문제
- yfinance: 100% Yahoo Finance -- 검증된 GitHub Actions 호환

Universe (200 종목):
- sectors.TICKER_TO_SECTOR 의 keys 가 KOSPI 200 ticker 리스트 (분기 1회 수동 갱신)

종료 코드:
    0  성공 또는 휴장일 SKIP
    1  네트워크 장애
    2  데이터 무결성 위반
"""
from __future__ import annotations

import logging
import time
from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import datetime, timezone, timedelta
from pathlib import Path

import pandas as pd
import yfinance as yf

from sectors import TICKER_TO_SECTOR, classify_sector

KST = timezone(timedelta(hours=9))

PROJECT_ROOT = Path(__file__).resolve().parent.parent
OUT_DIR = PROJECT_ROOT / "web" / "data"
OUT_DIR.mkdir(parents=True, exist_ok=True)

OUT_FILE = OUT_DIR / "treemap.json"
OUT_PRETTY = OUT_DIR / "treemap.pretty.json"
META_FILE = OUT_DIR / "_meta.json"

MIN_STOCKS = 150
MAX_CHANGE_PCT = 30.0
MAX_RETRIES = 3
BACKOFF_BASE = 1.0
PER_REQUEST_DELAY = 0.0
MARCAP_WORKERS = 16

KOREAN_NAMES = {
    "005930": "삼성전자",
    "000660": "SK하이닉스",
    "373220": "LG에너지솔루션",
    "207940": "삼성바이오로직스",
    "005380": "현대차",
    "000270": "기아",
    "005490": "POSCO홀딩스",
    "035420": "NAVER",
    "035720": "카카오",
    "051910": "LG화학",
    "006400": "삼성SDI",
    "068270": "셀트리온",
    "105560": "KB금융",
    "055550": "신한지주",
    "012330": "현대모비스",
    "028260": "삼성물산",
    "066570": "LG전자",
    "003670": "포스코퓨처엠",
    "032830": "삼성생명",
    "086790": "하나금융지주",
    "138040": "메리츠금융지주",
    "316140": "우리금융지주",
    "017670": "SK텔레콤",
    "030200": "KT",
    "033780": "KT&G",
    "015760": "한국전력",
    "009540": "HD한국조선해양",
    "024110": "기업은행",
    "011200": "HMM",
    "010130": "고려아연",
}

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s %(levelname)-7s %(message)s",
    datefmt="%H:%M:%S",
)
log = logging.getLogger("kospi-heatmap")


def with_retry(fn, *args, _label="", **kwargs):
    last_exc = None
    for attempt in range(1, MAX_RETRIES + 1):
        try:
            return fn(*args, **kwargs)
        except Exception as exc:
            last_exc = exc
            wait = BACKOFF_BASE * (2 ** (attempt - 1))
            log.warning(
                "%s 호출 실패 (시도 %d/%d): %s — %.1fs 대기 후 재시도",
                _label or fn.__name__, attempt, MAX_RETRIES, exc, wait,
            )
            if attempt < MAX_RETRIES:
                time.sleep(wait)
    raise RuntimeError(
        f"{_label or fn.__name__} 재시도 {MAX_RETRIES}회 모두 실패: {last_exc}"
    ) from last_exc


def _local_business_day_fallback():
    dt = datetime.now(KST)
    while dt.weekday() >= 5:
        dt -= timedelta(days=1)
    return dt.strftime("%Y%m%d")


def resolve_business_day(requested):
    today = datetime.now(KST).strftime("%Y%m%d")
    if requested:
        return requested, True
    fallback = _local_business_day_fallback()
    return fallback, fallback == today


def load_universe():
    codes = sorted(TICKER_TO_SECTOR.keys())
    log.info("Universe loaded: %d codes (sectors.TICKER_TO_SECTOR)", len(codes))
    return codes


def to_yf_symbol(code):
    return f"{code.zfill(6)}.KS"


def fetch_prices(codes):
    symbols = [to_yf_symbol(c) for c in codes]
    log.info("yf.download: %d symbols", len(symbols))

    df = with_retry(
        yf.download,
        tickers=" ".join(symbols),
        period="5d",
        interval="1d",
        group_by="ticker",
        threads=True,
        progress=False,
        auto_adjust=False,
        _label="yf.download",
    )

    if df is None or df.empty:
        raise RuntimeError("yf.download empty result")

    out = {}
    for code in codes:
        sym = to_yf_symbol(code)
        try:
            if isinstance(df.columns, pd.MultiIndex):
                sub = df[sym]
            else:
                sub = df
            closes = sub["Close"].dropna()
            if len(closes) < 2:
                continue
            today_close = float(closes.iloc[-1])
            prev_close = float(closes.iloc[-2])
            if prev_close <= 0:
                continue
            change = (today_close - prev_close) / prev_close * 100
            out[code] = {
                "today_close": today_close,
                "prev_close": prev_close,
                "change_pct": round(change, 2),
            }
        except (KeyError, IndexError, ValueError):
            continue

    log.info("Prices collected: %d/%d", len(out), len(codes))
    return out


def _fetch_one_marcap(code):
    sym = to_yf_symbol(code)
    try:
        t = yf.Ticker(sym)
        fi = t.fast_info
        cap = None
        if hasattr(fi, "get"):
            cap = fi.get("market_cap") or fi.get("marketCap")
        else:
            cap = getattr(fi, "market_cap", None) or getattr(fi, "marketCap", None)
        return code, int(cap) if cap else 0
    except Exception:
        return code, 0


def fetch_marcaps(codes):
    log.info("Marcap parallel fetch: %d codes (workers=%d)", len(codes), MARCAP_WORKERS)
    out = {}
    with ThreadPoolExecutor(max_workers=MARCAP_WORKERS) as ex:
        futures = {ex.submit(_fetch_one_marcap, c): c for c in codes}
        for fut in as_completed(futures):
            code, cap = fut.result()
            if cap > 0:
                out[code] = cap
    log.info("Marcap collected: %d/%d", len(out), len(codes))
    return out


def resolve_name(code):
    return KOREAN_NAMES.get(code, code)


def fetch_kospi200(date):
    log.info("Reference date: %s (yfinance)", date)

    codes = load_universe()
    prices = fetch_prices(codes)
    if not prices:
        raise RuntimeError("No prices collected -- Yahoo Finance response error")

    marcaps = fetch_marcaps(codes)
    if not marcaps:
        raise RuntimeError("No marcaps collected -- Yahoo Finance fast_info error")

    rows = []
    skipped = 0
    for code in codes:
        if code not in prices or code not in marcaps:
            skipped += 1
            continue
        p = prices[code]
        cap = marcaps[code]
        if cap <= 0:
            skipped += 1
            continue

        if abs(p["change_pct"]) > MAX_CHANGE_PCT:
            log.warning("Outlier excluded: %s change %+.2f%%", code, p["change_pct"])
            skipped += 1
            continue

        name = resolve_name(code)
        row = {
            "code": code,
            "name": name,
            "value": cap // 100_000_000,
            "change": p["change_pct"],
            "sector": classify_sector(code, name),
            "price": int(p["today_close"]),
        }
        rows.append(row)

    log.info("Collection complete: %d stocks (skipped %d)", len(rows), skipped)
    return rows
