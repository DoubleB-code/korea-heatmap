"""저장된 treemap.json 의 스키마 정합성 검증 (CI 게이트로 사용)."""
import json
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parent.parent
TREEMAP_JSON = ROOT / "web" / "data" / "treemap.json"


@pytest.fixture(scope="module")
def loaded_tree():
    if not TREEMAP_JSON.exists():
        pytest.skip("treemap.json 가 없음 — fetch_data.py 먼저 실행 필요")
    with open(TREEMAP_JSON, encoding="utf-8") as f:
        return json.load(f)


class TestRootSchema:
    REQUIRED = {
        "name": str,
        "as_of": str,
        "as_of_iso": str,
        "delay_minutes": int,
        "stock_count": int,
        "total_market_cap_eok": int,
        "weighted_change_pct": (int, float),
        "sectors": list,
        "children": list,
    }

    def test_required_keys_and_types(self, loaded_tree):
        for key, expected_type in self.REQUIRED.items():
            assert key in loaded_tree, f"키 누락: {key}"
            assert isinstance(loaded_tree[key], expected_type), \
                f"{key} 타입 오류: {type(loaded_tree[key])}"

    def test_as_of_format(self, loaded_tree):
        assert len(loaded_tree["as_of"]) == 8
        assert loaded_tree["as_of"].isdigit()
        assert loaded_tree["as_of_iso"].count("-") == 2


class TestSectors:
    def test_sectors_have_required_keys(self, loaded_tree):
        for sec in loaded_tree["sectors"]:
            assert "name" in sec
            assert "stock_count" in sec
            assert "total_value" in sec
            assert "weighted_change" in sec

    def test_sectors_sorted_desc(self, loaded_tree):
        values = [s["total_value"] for s in loaded_tree["sectors"]]
        assert values == sorted(values, reverse=True), "섹터가 시총 내림차순 아님"


class TestChildren:
    def test_each_sector_has_at_least_one_stock(self, loaded_tree):
        for sec in loaded_tree["children"]:
            assert len(sec["children"]) > 0, f"빈 섹터: {sec['name']}"

    def test_all_stocks_have_required_keys(self, loaded_tree):
        for sec in loaded_tree["children"]:
            for stock in sec["children"]:
                assert "code" in stock
                assert "name" in stock
                assert "value" in stock
                assert "change" in stock

    def test_all_codes_are_6_digit(self, loaded_tree):
        for sec in loaded_tree["children"]:
            for stock in sec["children"]:
                assert len(stock["code"]) == 6
                assert stock["code"].isdigit()

    def test_all_values_positive(self, loaded_tree):
        for sec in loaded_tree["children"]:
            for stock in sec["children"]:
                assert stock["value"] > 0

    def test_all_changes_within_price_limit(self, loaded_tree):
        for sec in loaded_tree["children"]:
            for stock in sec["children"]:
                assert abs(stock["change"]) <= 30.0, \
                    f"{stock['code']} {stock['name']} 등락률 {stock['change']}% 비정상"


class TestConsistency:
    def test_total_cap_matches_sum_of_sectors(self, loaded_tree):
        total_from_sectors = sum(s["total_value"] for s in loaded_tree["sectors"])
        assert total_from_sectors == loaded_tree["total_market_cap_eok"]

    def test_stock_count_matches_sum(self, loaded_tree):
        total_from_sectors = sum(s["stock_count"] for s in loaded_tree["sectors"])
        assert total_from_sectors == loaded_tree["stock_count"]

    def test_sectors_count_matches_children_count(self, loaded_tree):
        assert len(loaded_tree["sectors"]) == len(loaded_tree["children"])
