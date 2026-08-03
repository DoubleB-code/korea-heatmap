"""
CI 후처리 게이트: 갱신된 treemap.json 이 모든 스키마·범위 검증 통과하는지 단독 실행.

실행:
    python tests/validate_output.py [path]

종료 코드:
    0  통과
    1  실패
"""
import json
import sys
from pathlib import Path


def validate(path: Path) -> list[str]:
    errors: list[str] = []

    if not path.exists():
        return [f"파일 없음: {path}"]

    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except json.JSONDecodeError as e:
        return [f"JSON 파싱 실패: {e}"]

    required = ["name", "as_of", "as_of_iso", "delay_minutes",
                "stock_count", "total_market_cap_eok", "weighted_change_pct",
                "sectors", "children"]
    for k in required:
        if k not in data:
            errors.append(f"필수 키 누락: {k}")

    if errors:
        return errors

    if data["stock_count"] < 150:
        errors.append(f"종목 수 부족: {data['stock_count']} < 150")

    if data["total_market_cap_eok"] <= 0:
        errors.append("총 시총이 0 이하")

    total_from_sectors = sum(s["total_value"] for s in data["sectors"])
    if total_from_sectors != data["total_market_cap_eok"]:
        errors.append(f"시총 합계 불일치: {total_from_sectors} != {data['total_market_cap_eok']}")

    for sec in data["children"]:
        if not sec["children"]:
            errors.append(f"빈 섹터: {sec['name']}")
        for s in sec["children"]:
            if s["value"] <= 0:
                errors.append(f"{s['code']} 시총 비정상")
            if abs(s["change"]) > 30.0:
                errors.append(f"{s['code']} {s['name']} 등락률 {s['change']}% 비정상")
            if not (len(s["code"]) == 6 and s["code"].isdigit()):
                errors.append(f"{s['code']} 코드 형식 오류")

    return errors


def main() -> int:
    path = Path(sys.argv[1]) if len(sys.argv) > 1 else Path("web/data/treemap.json")
    errors = validate(path)
    if errors:
        print(f"❌ 검증 실패 ({len(errors)}건):", file=sys.stderr)
        for e in errors:
            print(f"  - {e}", file=sys.stderr)
        return 1
    print(f"✓ {path} 검증 통과")
    return 0


if __name__ == "__main__":
    sys.exit(main())
