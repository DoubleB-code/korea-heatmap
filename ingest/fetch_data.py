"""
KOSPI 200 일별 스냅샷 수집 (안정화 레이어 적용).

운영 정책 (한국 영업일 KST 기준):
    - 09:30  시초가 안정화 직후
    - 13:00  점심 시간 직후
    - 16:00  정규장 마감 + 종가 동시호가 반영 직후

안정화 기능:
    - 재시도(3회) + 지수 백오프 (1s, 2s, 4s)
    - 영업일 자동 감지 (휴장일이면 직전 영업일 사용)
    - 휴장일 감지 시 작업 SKIP (commit 안 일어남)
    - 직전 정상 스냅샷 폴백 (수집 완전 실패 시)
    - 결과 검증 (모든 종목 시총 > 0, 등락률 절대값 < 30%)

실행:
    python ingest/fetch_data.py [--date YYYYMMDD] [--dry-run]

종료 코드:
    0  성공 (또는 휴장일 SKIP)
    1  네트워크·KRX 장애 (재시도 후에도 실패)
    2  데이터 무결성 위반 (수집됐으나 검증 실패)
"""
from __future__ import annotations

import argparse
import json
import logging
import sys
import time
from datetime import datetime, timezone, timedelta

KST = timezone(timedelta(hours=9))
from pathlib import Path
from typing import Callable, Optional, Tuple, TypeVar

from pykrx import stock

from sectors import classify_sector

# ============================================================
# 상수
# ============================================================
KOSPI200_INDEX = "1028"
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

PER_REQUEST_DELAY = 0.02

# ============================================================
# 로깅
# ============================================================
logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s %(levelname)-7s %(message)s",
    datefmt="%H:%M:%S",
)
log = logging.getLogger("kospi-heatmap")


# ============================================================
# 재시도
# ============================================================
T = TypeVar("T")


def with_retry(fn, *args, _label="", **kwargs):
    """함수 호출을 재시도 + 지수 백오프로 감쌈."""
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


# ============================================================
# 영업일
# ============================================================
def resolve_business_day(requested):
    """요청일을 영업일로 보정. 반환: (YYYYMMDD, 오늘이 영업일인지)."""
    today = datetime.now(KST).strftime("%Y%m%d")

    if requested:
        nearest = with_retry(
            stock.get_nearest_business_day_in_a_week,
            requested,
            _label="get_nearest_business_day_in_a_week(requested)",
        )
        return nearest, True

    nearest = with_retry(
        stock.get_nearest_business_day_in_a_week,
        _label="get_nearest_business_day_in_a_week(today)",
    )
    return nearest, nearest == today


# ============================================================
# 수집
# ============================================================
def fetch_kospi200(date):
    log.info("기준일: %s", date)

    constituents = with_retry(
        stock.get_index_portfolio_deposit_file,
        KOSPI200_INDEX, date=date,
        _label="get_index_portfolio_deposit_file",
    )
    log.info("KOSPI 200 구성종목: %d개", len(constituents))

    cap_df = with_retry(
        stock.get_market_cap_by_ticker,
        date, market="KOSPI",
        _label="get_market_cap_by_ticker",
    )
    ohlcv_df = with_retry(
        stock.get_market_ohlcv_by_ticker,
        date, market="KOSPI",
        _label="get_market_ohlcv_by_ticker",
    )

    rows = []
    skipped = []

    for code in constituents:
        if code not in cap_df.index:
            skipped.append(code)
            continue

        market_cap = int(cap_df.at[code, "시가총액"])
        if market_cap <= 0:
            skipped.append(code)
            continue

        change_pct = None
        if "등락률" in cap_df.columns:
            change_pct = float(cap_df.at[code, "등락률"])
        elif code in ohlcv_df.index and "등락률" in ohlcv_df.columns:
            change_pct = float(ohlcv_df.at[code, "등락률"])

        if change_pct is None:
            skipped.append(code)
            continue

        try:
            name = with_retry(
                stock.get_market_ticker_name, code,
                _label=f"get_market_ticker_name({code})",
            )
        except Exception:
            name = code

        rows.append({
            "code": code,
            "name": name,
            "value": market_cap // 100_000_000,
            "change": round(change_pct, 2),
            "sector": classify_sector(code, name),
        })

        time.sleep(PER_REQUEST_DELAY)

    if skipped:
        log.warning("데이터 누락 %d건: %s%s",
                    len(skipped), skipped[:5], "..." if len(skipped) > 5 else "")

    log.info("수집 완료: %d개", len(rows))
    return rows
