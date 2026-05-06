"""
KOSPI 200 일별 스냅샷 수집 (FinanceDataReader 기반).

PyKRX → FinanceDataReader 전환 이유:
- KRX가 GitHub Actions IP를 차단해서 PyKRX 작동 불가
- FinanceDataReader는 야후 파이낸스 + KRX 혼합 — GitHub Actions에서 정상 작동

운영 정책 (한국 영업일 KST 기준):
    - 매 30분 갱신 (월~금 09:00 ~ 16:30 KST)

종료 코드:
    0  성공 또는 휴장일 SKIP
    1  네트워크 장애
    2  데이터 무결성 위반
"""
from __future__ import annotations

import logging
import time
from datetime import datetime, timezone, timedelta

KST = timezone(timedelta(hours=9))
from pathlib import Path

import FinanceDataReader as fdr

from sectors import classify_sector

# ============================================================
# 상수
# ============================================================
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
PER_REQUEST_DELAY = 0.0  # fdr는 일괄 호출이라 종목별 sleep 불필요

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


# ============================================================
# 영업일 (로컬 calendar 기반 — 외부 API 호출 없음)
# ============================================================
def _local_business_day_fallback():
    dt = datetime.now(KST)
    while dt.weekday() >= 5:
        dt -= timedelta(days=1)
    return dt.strftime("%Y%m%d")


def resolve_business_day(requested):
    """요청일 또는 오늘을 영업일로 보정. 외부 API 사용 안 함."""
    today = datetime.now(KST).strftime("%Y%m%d")
    if requested:
        return requested, True
    fallback = _local_business_day_fallback()
    return fallback, fallback == today


# ============================================================
# KOSPI 200 수집 — FinanceDataReader (야후 + KRX 혼합)
# ============================================================
def fetch_kospi200(date):
    """KOSPI 200 구성종목의 시총·등락률·종가를 받아온다.

    fdr.StockListing('KOSPI200') — 구성종목 리스트
    fdr.StockListing('KOSPI')    — 전체 KOSPI 시세 (Marcap, Close, ChagesRatio 포함)
    """
    log.info("기준일: %s (FinanceDataReader)", date)

    # 1) KOSPI 200 구성종목 리스트
    kospi200 = with_retry(fdr.StockListing, "KOSPI200", _label="StockListing(KOSPI200)")
    log.info("KOSPI 200 구성종목 받음: %d행", len(kospi200))

    # 2) 전체 KOSPI 시세 (시총·종가·등락률 한 번에)
    kospi_all = with_retry(fdr.StockListing, "KOSPI", _label="StockListing(KOSPI)")
    log.info("KOSPI 전체 시세 받음: %d행", len(kospi_all))

    # 3) 컬럼명 정규화
    def col(df, *candidates):
        for c in candidates:
            if c in df.columns:
                return c
        return None

    code_col_200 = col(kospi200, "Code", "Symbol")
    code_col_all = col(kospi_all, "Code", "Symbol")
    name_col = col(kospi_all, "Name")
    cap_col = col(kospi_all, "Marcap", "MarketCap")
    change_col = col(kospi_all, "ChagesRatio", "ChangesRatio", "ChangeRatio")
    close_col = col(kospi_all, "Close")

    if not all([code_col_200, code_col_all, name_col, cap_col, change_col]):
        raise RuntimeError(f"필수 컬럼 누락. KOSPI 컬럼: {list(kospi_all.columns)}")

    # 4) KOSPI 200 코드 set (6자리 zero-pad)
    kospi200_codes = set(
        str(c).zfill(6) for c in kospi200[code_col_200].astype(str)
    )

    # 5) KOSPI 200 만 필터 + row 변환
    rows = []
    for _, r in kospi_all.iterrows():
        code = str(r[code_col_all]).zfill(6)
        if code not in kospi200_codes:
            continue
        try:
            cap = int(r[cap_col] or 0)
            change = float(r[change_col] or 0)
            close = int(r[close_col] or 0) if close_col else 0
            name = str(r[name_col]) if r[name_col] else code
        except Exception:
            continue
        if cap <= 0:
            continue
        row = {
            "code": code,
            "name": name,
            "value": cap // 100_000_000,  # 억원
            "change": round(change, 2),
            "sector": classify_sector(code, name),
        }
        if close > 0:
            row["price"] = close
        rows.append(row)

    log.info("수집 완료: %d개 (KOSPI 200 매칭)", len(rows))
    return rows
