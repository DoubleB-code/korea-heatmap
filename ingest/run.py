"""
KOSPI 200 갱신 진입점.

실행:
    python ingest/run.py [--date YYYYMMDD] [--dry-run]

종료 코드:
    0  성공 또는 휴장일 SKIP
    1  네트워크·KRX 장애
    2  무결성 검증 실패
"""
import argparse
import json
import logging
import sys
from datetime import datetime, timezone, timedelta

KST = timezone(timedelta(hours=9))
from pathlib import Path

from fetch_data import resolve_business_day, fetch_kospi200
from hierarchy import build_hierarchy, validate_tree, IntegrityError

PROJECT_ROOT = Path(__file__).resolve().parent.parent
OUT_DIR = PROJECT_ROOT / "web" / "data"
OUT_DIR.mkdir(parents=True, exist_ok=True)
OUT_FILE = OUT_DIR / "treemap.json"
OUT_PRETTY = OUT_DIR / "treemap.pretty.json"
META_FILE = OUT_DIR / "_meta.json"

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s %(levelname)-7s %(message)s",
    datefmt="%H:%M:%S",
)
log = logging.getLogger("run")


def load_meta():
    if META_FILE.exists():
        try:
            return json.loads(META_FILE.read_text(encoding="utf-8"))
        except Exception:
            pass
    return {"last_success_iso": None, "consecutive_failures": 0, "last_error": None}


def save_meta(meta):
    META_FILE.write_text(
        json.dumps(meta, indent=2, ensure_ascii=False),
        encoding="utf-8",
    )


def _atomic_write(path, content):
    """tmp 파일에 쓴 뒤 os.replace 로 교체. 부분 쓰기 방지."""
    import os, tempfile
    fd, tmp = tempfile.mkstemp(dir=str(path.parent), prefix=".tmp_", suffix=".part")
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as f:
            f.write(content)
        os.replace(tmp, path)
    except Exception:
        try: os.unlink(tmp)
        except OSError: pass
        raise


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--date", help="기준일 YYYYMMDD")
    parser.add_argument("--dry-run", action="store_true")
    parser.add_argument("--allow-non-business-day", action="store_true")
    args = parser.parse_args()

    meta = load_meta()

    try:
        date, is_business_day = resolve_business_day(args.date)
    except Exception as exc:
        meta["consecutive_failures"] += 1
        meta["last_error"] = f"resolve_business_day: {exc}"
        save_meta(meta)
        log.error("영업일 결정 실패: %s", exc)
        return 1

    if not is_business_day and not args.allow_non_business_day and not args.date:
        log.info("오늘은 휴장일 — 작업을 건너뜁니다 (직전 영업일: %s)", date)
        return 0

    try:
        rows = fetch_kospi200(date)
    except Exception as exc:
        meta["consecutive_failures"] += 1
        meta["last_error"] = f"fetch_kospi200: {exc}"
        save_meta(meta)
        log.error("수집 실패: %s", exc)
        return 1

    if not rows:
        meta["consecutive_failures"] += 1
        meta["last_error"] = "수집된 종목 0건"
        save_meta(meta)
        log.error("수집된 종목이 없습니다.")
        return 1

    tree = build_hierarchy(date, rows)

    # sparkline은 이제 fetch_data.py가 yfinance에서 진짜 30일 일봉으로 직접 채움
    # → 30분 단위 누적 X, 즉시 30일 차트 표시
    n_spark = sum(1 for sec in tree["children"] for s in sec["children"] if s.get("spark"))
    log.info("✓ sparkline (yfinance 30일 일봉): %d종목", n_spark)

    try:
        validate_tree(tree)
    except IntegrityError as exc:
        meta["consecutive_failures"] += 1
        meta["last_error"] = f"validate_tree: {exc}"
        save_meta(meta)
        log.error("무결성 검증 실패: %s", exc)
        log.error("기존 treemap.json은 유지됩니다 (폴백).")
        return 2

    if args.dry_run:
        log.info("[dry-run] 종목=%d, 시총=%.1f조, 가중평균=%+.3f%%",
                 tree["stock_count"], tree["total_market_cap_eok"]/10000,
                 tree["weighted_change_pct"])
        return 0

    _atomic_write(OUT_FILE, json.dumps(tree, ensure_ascii=False, separators=(",", ":")))
    _atomic_write(OUT_PRETTY, json.dumps(tree, ensure_ascii=False, indent=2))

    meta["last_success_iso"] = datetime.now(KST).isoformat(timespec="seconds")
    meta["consecutive_failures"] = 0
    meta["last_error"] = None
    save_meta(meta)

    log.info("✓ 저장: %s (%d bytes)", OUT_FILE.name, OUT_FILE.stat().st_size)
    log.info("✓ 가중평균: %+.3f%%", tree["weighted_change_pct"])
    log.info("✓ 섹터: %d", len(tree["sectors"]))
    return 0


if __name__ == "__main__":
    sys.exit(main())
