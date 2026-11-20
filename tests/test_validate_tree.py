"""hierarchy.validate_tree 무결성 검증 테스트."""
import pytest
from hierarchy import validate_tree, IntegrityError, build_hierarchy


def make_valid_tree(stock_count=160):
    rows = [
        {"code": f"{i:06d}", "name": f"종목{i}", "value": 1000 + i,
         "change": 0.5, "sector": "IT"}
        for i in range(stock_count)
    ]
    return build_hierarchy("20260505", rows)


class TestValidTree:
    def test_minimal_valid_tree_passes(self):
        validate_tree(make_valid_tree(stock_count=160))

    def test_full_kospi200_passes(self):
        validate_tree(make_valid_tree(stock_count=200))


class TestStockCount:
    def test_too_few_stocks_fails(self):
        with pytest.raises(IntegrityError, match="종목 수 부족"):
            validate_tree(make_valid_tree(stock_count=100))

    def test_zero_stocks_fails(self):
        with pytest.raises(IntegrityError):
            validate_tree(make_valid_tree(stock_count=0))


class TestMarketCap:
    def test_zero_market_cap_fails(self):
        tree = make_valid_tree(160)
        tree["children"][0]["children"][0]["value"] = 0
        with pytest.raises(IntegrityError, match="시총이 0 이하"):
            validate_tree(tree)

    def test_negative_market_cap_fails(self):
        tree = make_valid_tree(160)
        tree["children"][0]["children"][0]["value"] = -100
        with pytest.raises(IntegrityError):
            validate_tree(tree)


class TestChangePct:
    def test_extreme_change_fails(self):
        tree = make_valid_tree(160)
        tree["children"][0]["children"][0]["change"] = 50.0
        with pytest.raises(IntegrityError, match="등락률 비정상"):
            validate_tree(tree)

    def test_extreme_negative_change_fails(self):
        tree = make_valid_tree(160)
        tree["children"][0]["children"][0]["change"] = -50.0
        with pytest.raises(IntegrityError):
            validate_tree(tree)

    def test_boundary_30pct_passes(self):
        tree = make_valid_tree(160)
        tree["children"][0]["children"][0]["change"] = 29.99
        validate_tree(tree)


class TestTickerCode:
    def test_invalid_code_format_fails(self):
        tree = make_valid_tree(160)
        tree["children"][0]["children"][0]["code"] = "12345"
        with pytest.raises(IntegrityError, match="종목코드 형식"):
            validate_tree(tree)

    def test_non_numeric_code_fails(self):
        tree = make_valid_tree(160)
        tree["children"][0]["children"][0]["code"] = "AAAAAA"
        with pytest.raises(IntegrityError):
            validate_tree(tree)
