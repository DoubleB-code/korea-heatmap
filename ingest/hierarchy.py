"""트리맵 hierarchical 구조 생성 + 무결성 검증."""
from datetime import datetime

# 검증 임계치
MIN_STOCKS = 150
MAX_CHANGE_PCT = 30.0


def build_hierarchy(date, rows):
    """rows → D3 hierarchical 트리. 섹터/종목 모두 시총 내림차순 정렬.

    price 필드는 트리맵 렌더링/포트폴리오 손익/sparkline 누적에 필수.
    fetch_data 가 채우면 보존, 없으면 생략.
    """
    by_sector = {}
    for r in rows:
        item = {
            "code": r["code"],
            "name": r["name"],
            "value": r["value"],
            "change": r["change"],
        }
        if r.get("price"):
            item["price"] = r["price"]
        if r.get("spark") and isinstance(r["spark"], list):
            item["spark"] = r["spark"]
        by_sector.setdefault(r["sector"], []).append(item)

    children = sorted(
        [{"name": s, "children": items} for s, items in by_sector.items()],
        key=lambda x: -sum(c["value"] for c in x["children"]),
    )
    for sec in children:
        sec["children"].sort(key=lambda x: -x["value"])

    total_cap = sum(r["value"] for r in rows)
    weighted_change = (
        sum(r["value"] * r["change"] for r in rows) / total_cap
        if total_cap else 0.0
    )

    return {
        "name": "KOSPI 200",
        "as_of": date,
        "as_of_iso": datetime.strptime(date, "%Y%m%d").strftime("%Y-%m-%d"),
        "delay_minutes": 15,
        "stock_count": len(rows),
        "total_market_cap_eok": total_cap,
        "weighted_change_pct": round(weighted_change, 3),
        "sectors": [
            {
                "name": sec["name"],
                "stock_count": len(sec["children"]),
                "total_value": sum(c["value"] for c in sec["children"]),
                "weighted_change": round(
                    sum(c["value"] * c["change"] for c in sec["children"]) /
                    max(1, sum(c["value"] for c in sec["children"])), 3
                ),
            }
            for sec in children
        ],
        "children": children,
    }


class IntegrityError(Exception):
    """수집 결과가 무결성 기준을 위반."""


def validate_tree(tree):
    """트리 무결성 검증. 실패 시 IntegrityError raise."""
    sc = tree.get("stock_count", 0)
    if sc < MIN_STOCKS:
        raise IntegrityError(f"종목 수 부족 ({sc} < {MIN_STOCKS})")

    if tree.get("total_market_cap_eok", 0) <= 0:
        raise IntegrityError("총 시총이 0 이하")

    for sec in tree.get("children", []):
        for s in sec.get("children", []):
            if s["value"] <= 0:
                raise IntegrityError(f"{s['code']} 시총이 0 이하: {s['value']}")
            if abs(s["change"]) > MAX_CHANGE_PCT:
                raise IntegrityError(f"{s['code']} 등락률 비정상: {s['change']}%")
            if not (len(s["code"]) == 6 and s["code"].isdigit()):
                raise IntegrityError(f"종목코드 형식 오류: {s['code']}")
