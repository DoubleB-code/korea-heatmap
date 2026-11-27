"""hierarchy.build_hierarchy 단위 테스트."""
import pytest
from hierarchy import build_hierarchy


def make_row(code, name, value, change, sector):
    return {"code": code, "name": name, "value": value, "change": change, "sector": sector}


class TestBasicStructure:
    def test_empty_rows(self):
        tree = build_hierarchy("20260505", [])
        assert tree["stock_count"] == 0
        assert tree["total_market_cap_eok"] == 0
        assert tree["weighted_change_pct"] == 0.0
        assert tree["children"] == []

    def test_single_row(self):
        rows = [make_row("005930", "삼성전자", 4700000, 1.5, "IT")]
        tree = build_hierarchy("20260505", rows)
        assert tree["stock_count"] == 1
        assert tree["total_market_cap_eok"] == 4700000
        assert tree["weighted_change_pct"] == 1.5
        assert len(tree["children"]) == 1
        assert tree["children"][0]["name"] == "IT"

    def test_required_keys(self):
        rows = [make_row("005930", "삼성전자", 100, 1.0, "IT")]
        tree = build_hierarchy("20260505", rows)
        required = {"name", "as_of", "as_of_iso", "delay_minutes",
                    "stock_count", "total_market_cap_eok",
                    "weighted_change_pct", "sectors", "children"}
        assert required.issubset(tree.keys())


class TestSorting:
    def test_sectors_sorted_by_total_value_desc(self):
        rows = [
            make_row("A1", "A", 100, 1.0, "금융"),
            make_row("B1", "B", 500, 1.0, "IT"),
            make_row("B2", "C", 1000, 1.0, "IT"),
            make_row("C1", "D", 300, 1.0, "헬스케어"),
        ]
        tree = build_hierarchy("20260505", rows)
        names = [s["name"] for s in tree["children"]]
        assert names == ["IT", "헬스케어", "금융"]

    def test_stocks_within_sector_sorted_desc(self):
        rows = [
            make_row("S1", "small", 100, 0.0, "IT"),
            make_row("S2", "big", 5000, 0.0, "IT"),
            make_row("S3", "mid", 1000, 0.0, "IT"),
        ]
        tree = build_hierarchy("20260505", rows)
        values = [c["value"] for c in tree["children"][0]["children"]]
        assert values == [5000, 1000, 100]


class TestWeightedChange:
    def test_weighted_average_calculation(self):
        rows = [
            make_row("A", "A", 8000, 2.0, "IT"),
            make_row("B", "B", 2000, -3.0, "IT"),
        ]
        tree = build_hierarchy("20260505", rows)
        assert tree["weighted_change_pct"] == 1.0

    def test_sector_weighted_change(self):
        rows = [
            make_row("A", "A", 5000, 4.0, "IT"),
            make_row("B", "B", 5000, -2.0, "IT"),
            make_row("C", "C", 1000, 0.5, "금융"),
        ]
        tree = build_hierarchy("20260505", rows)
        it_sector = next(s for s in tree["sectors"] if s["name"] == "IT")
        assert it_sector["weighted_change"] == 1.0

    def test_zero_total_cap_no_division_error(self):
        tree = build_hierarchy("20260505", [])
        assert tree["weighted_change_pct"] == 0.0


class TestDateHandling:
    def test_iso_date_conversion(self):
        tree = build_hierarchy("20260505", [])
        assert tree["as_of"] == "20260505"
        assert tree["as_of_iso"] == "2026-05-05"

    def test_invalid_date_raises(self):
        with pytest.raises(ValueError):
            build_hierarchy("invalid", [])
