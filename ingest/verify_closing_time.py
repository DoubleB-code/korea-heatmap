"""
yfinance 종가 확정 시점 검증.

목적:
    D3 정산 cron 진입 시점(16:00 / 17:00 / 18:00 KST)에 yfinance 가
    당일 확정 종가를 안정적으로 반환하는지 검증.

사용:
    # 1. 16:00 KST 직후 1차 측정
    python ingest/verify_closing_time.py --tag "16:00" --out /tmp/y_1600.json

    # 2. 17:00 KST 직후 2차 측정
    python ingest/verify_closing_time.py --tag "17:00" --out /tmp/y_1700.json

    # 3. 18:00 KST 직후 3차 측정
    python ingest/verify_closing_time.py --tag "18:00" --out /tmp/y_1800.json

    # 4. 비교 (16:00 vs 17:00 vs 18:00 종가가 동일한지)
    python ingest/verify_closing_time.py --compare /tmp/y_1600.json /tmp/y_1700.json /tmp/y_1800.json

종가가 시점별로 다르면 → 정산 cron 시점을 더 늦춰야 함.
"""
import argparse
import json
import sys
from datetime import datetime, timezone, timedelta
from pathlib import Path

import yfinance as yf

KST = timezone(timedelta(hours=9))

# TOP30 검증용 (시총 상위 30개 — treemap.json 에서 추출)
TEST_TICKERS = [
    "005930", "000660", "005380", "402340", "373220",
    "034020", "028260", "329180", "012450", "000270",
    "009150", "207940", "105560", "032830", "006400",
    "012330", "267260", "055550", "006800", "068270",
    "298040", "042660", "086790", "035420", "005490",
    "000810", "066570", "010130", "017670", "051910",
]


def fetch_closing(tickers, tag=""):
    """각 ticker 의 당일 종가 + fetched_at 기록."""
    fetched_at = datetime.now(KST).isoformat(timespec="seconds")
    results = {}

    for code in tickers:
        sym = f"{code}.KS"
        try:
            t = yf.Ticker(sym)
            # 2일치만 가져와서 마지막 행이 오늘인지 확인
            hist = t.history(period="2d", auto_adjust=False)
            if hist.empty:
                results[code] = {"status": "EMPTY", "close": None}
                continue

            last_row = hist.iloc[-1]
            last_date = hist.index[-1].strftime("%Y-%m-%d")
            results[code] = {
                "status": "OK",
                "close": float(last_row["Close"]),
                "volume": int(last_row["Volume"]),
                "data_date": last_date,
                "fetched_at": fetched_at,
            }
        except Exception as e:
            results[code] = {"status": "ERROR", "error": str(e), "close": None}

    return {
        "tag": tag,
        "fetched_at": fetched_at,
        "ticker_count": len(tickers),
        "success_count": sum(1 for r in results.values() if r["status"] == "OK"),
        "data": results,
    }


def compare_snapshots(paths):
    """여러 스냅샷의 종가 일치도 비교."""
    snapshots = []
    for p in paths:
        snap = json.loads(Path(p).read_text(encoding="utf-8"))
        snapshots.append(snap)

    print(f"\n{'='*70}")
    print(f"비교 대상: {len(snapshots)}개 스냅샷")
    for s in snapshots:
        print(f"  [{s['tag']}] {s['fetched_at']} — {s['success_count']}/{s['ticker_count']} 성공")
    print("="*70)

    base = snapshots[0]["data"]
    discrepancies = []
    same_count = 0
    diff_count = 0

    for code, base_row in base.items():
        if base_row["status"] != "OK":
            continue

        base_close = base_row["close"]
        base_date = base_row["data_date"]
        statuses = []

        for snap in snapshots[1:]:
            cmp_row = snap["data"].get(code, {})
            if cmp_row.get("status") != "OK":
                statuses.append(f"{snap['tag']}=MISS")
                continue

            if cmp_row["close"] == base_close and cmp_row["data_date"] == base_date:
                statuses.append(f"{snap['tag']}=SAME")
            else:
                statuses.append(f"{snap['tag']}={cmp_row['close']:.0f}")

        if any("=SAME" not in s and "=MISS" not in s for s in statuses):
            discrepancies.append({
                "code": code,
                "base": f"[{snapshots[0]['tag']}] {base_close:.0f} ({base_date})",
                "others": statuses,
            })
            diff_count += 1
        else:
            same_count += 1

    print(f"\n동일: {same_count}, 차이: {diff_count}")
    if discrepancies:
        print(f"\n불일치 종목 ({len(discrepancies)}개):")
        for d in discrepancies[:20]:
            print(f"  {d['code']}: base={d['base']} → {', '.join(d['others'])}")
        if len(discrepancies) > 20:
            print(f"  ... 외 {len(discrepancies) - 20}개")

    # Go/No-Go 판정
    print(f"\n{'='*70}")
    diff_ratio = diff_count / max(1, same_count + diff_count)
    if diff_ratio < 0.02:
        print(f"✓ GO: 불일치 {diff_ratio*100:.1f}% (2% 미만) — 정산 안정")
        return 0
    elif diff_ratio < 0.10:
        print(f"⚠ CAUTION: 불일치 {diff_ratio*100:.1f}% — 정산 시점 1시간 추가 늦출 것 권고")
        return 1
    else:
        print(f"✗ NO-GO: 불일치 {diff_ratio*100:.1f}% — yfinance 단독 정산 불가, KRX 직접 호출 필요")
        return 2


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--tag", default="", help="스냅샷 라벨 (예: 16:00)")
    ap.add_argument("--out", help="결과 저장 경로 JSON")
    ap.add_argument("--compare", nargs="+", help="비교할 스냅샷 파일들")
    args = ap.parse_args()

    if args.compare:
        return compare_snapshots(args.compare)

    snap = fetch_closing(TEST_TICKERS, tag=args.tag)
    print(f"[{snap['tag']}] {snap['fetched_at']}")
    print(f"성공: {snap['success_count']}/{snap['ticker_count']}")

    if args.out:
        Path(args.out).write_text(
            json.dumps(snap, ensure_ascii=False, indent=2),
            encoding="utf-8"
        )
        print(f"→ {args.out}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
