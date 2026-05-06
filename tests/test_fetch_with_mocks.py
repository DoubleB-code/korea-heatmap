"""
fetch_kospi200, resolve_business_day 를 PyKRX 모킹으로 검증.
샌드박스에 네트워크 없는 환경에서도 동작 확인.
"""
import pytest
import pandas as pd
from unittest.mock import patch, MagicMock

import fetch_data


@pytest.fixture(autouse=True)
def fast_settings(monkeypatch):
    """테스트 속도용 설정."""
    monkeypatch.setattr(fetch_data, "BACKOFF_BASE", 0.001)
    monkeypatch.setattr(fetch_data, "PER_REQUEST_DELAY", 0.0)


def make_cap_df(rows):
    """[(code, market_cap, change_pct), ...] → DataFrame."""
    df = pd.DataFrame(
        [{"시가총액": cap, "등락률": chg, "종가": max(1, cap // 1_000_000_000)} for _, cap, chg in rows],
        index=[c for c, _, _ in rows],
    )
    df.index.name = "티커"
    return df


def make_ohlcv_df(rows):
    df = pd.DataFrame(
        [{"등락률": chg, "거래량": 1000} for _, _, chg in rows],
        index=[c for c, _, _ in rows],
    )
    df.index.name = "티커"
    return df


class TestFetchKospi200:
    def test_basic_fetch(self):
        constituents = ["005930", "000660", "207940"]
        cap_data = [
            ("005930", 470_000_000_000_000, 1.23),
            ("000660", 152_000_000_000_000, -0.61),
            ("207940", 72_000_000_000_000, 1.55),
        ]
        with patch("fetch_data.stock") as mock_stock:
            mock_stock.get_index_portfolio_deposit_file.return_value = constituents
            mock_stock.get_market_cap_by_ticker.return_value = make_cap_df(cap_data)
            mock_stock.get_market_ohlcv_by_ticker.return_value = make_ohlcv_df(cap_data)
            mock_stock.get_market_ticker_name.side_effect = lambda c: {
                "005930": "삼성전자", "000660": "SK하이닉스", "207940": "삼성바이오로직스"
            }[c]

            rows = fetch_data.fetch_kospi200("20260505")

        assert len(rows) == 3
        assert rows[0]["code"] == "005930"
        assert rows[0]["name"] == "삼성전자"
        assert rows[0]["value"] == 4_700_000  # 시총을 억원으로 변환
        assert rows[0]["change"] == 1.23
        assert rows[0]["sector"] == "IT"

    def test_skips_stocks_with_zero_cap(self):
        constituents = ["005930", "999998"]
        cap_data = [
            ("005930", 470_000_000_000_000, 1.0),
            ("999998", 0, 0.0),  # 시총 0 → 스킵
        ]
        with patch("fetch_data.stock") as mock_stock:
            mock_stock.get_index_portfolio_deposit_file.return_value = constituents
            mock_stock.get_market_cap_by_ticker.return_value = make_cap_df(cap_data)
            mock_stock.get_market_ohlcv_by_ticker.return_value = make_ohlcv_df(cap_data)
            mock_stock.get_market_ticker_name.return_value = "X"

            rows = fetch_data.fetch_kospi200("20260505")

        assert len(rows) == 1
        assert rows[0]["code"] == "005930"

    def test_skips_stocks_not_in_cap_df(self):
        constituents = ["005930", "999997"]  # 999997 은 cap_df 에 없음
        cap_data = [("005930", 100_000_000_000_000, 1.0)]
        with patch("fetch_data.stock") as mock_stock:
            mock_stock.get_index_portfolio_deposit_file.return_value = constituents
            mock_stock.get_market_cap_by_ticker.return_value = make_cap_df(cap_data)
            mock_stock.get_market_ohlcv_by_ticker.return_value = make_ohlcv_df(cap_data)
            mock_stock.get_market_ticker_name.return_value = "삼성전자"

            rows = fetch_data.fetch_kospi200("20260505")
        assert len(rows) == 1

    def test_ticker_name_failure_falls_back_to_code(self):
        constituents = ["005930"]
        cap_data = [("005930", 100_000_000_000_000, 1.0)]
        with patch("fetch_data.stock") as mock_stock:
            mock_stock.get_index_portfolio_deposit_file.return_value = constituents
            mock_stock.get_market_cap_by_ticker.return_value = make_cap_df(cap_data)
            mock_stock.get_market_ohlcv_by_ticker.return_value = make_ohlcv_df(cap_data)
            mock_stock.get_market_ticker_name.side_effect = Exception("network")

            rows = fetch_data.fetch_kospi200("20260505")
        assert len(rows) == 1
        # 이름 호출 실패 시 코드로 fallback
        assert rows[0]["name"] == "005930"

    def test_retry_on_constituents_call(self):
        constituents = ["005930"]
        cap_data = [("005930", 100_000_000_000_000, 1.0)]

        call_count = [0]
        def flaky_constituents(*a, **kw):
            call_count[0] += 1
            if call_count[0] < 2:
                raise ConnectionError("flaky")
            return constituents

        with patch("fetch_data.stock") as mock_stock:
            mock_stock.get_index_portfolio_deposit_file.side_effect = flaky_constituents
            mock_stock.get_market_cap_by_ticker.return_value = make_cap_df(cap_data)
            mock_stock.get_market_ohlcv_by_ticker.return_value = make_ohlcv_df(cap_data)
            mock_stock.get_market_ticker_name.return_value = "삼성전자"

            rows = fetch_data.fetch_kospi200("20260505")
        assert call_count[0] == 2
        assert len(rows) == 1


class TestResolveBusinessDay:
    def test_today_is_business_day(self):
        from datetime import datetime
        from fetch_data import KST
        today_kst = datetime.now(KST).strftime("%Y%m%d")
        with patch("fetch_data.stock") as mock_stock:
            mock_stock.get_nearest_business_day_in_a_week.return_value = today_kst
            date, is_biz = fetch_data.resolve_business_day(None)
        assert date == today_kst
        assert is_biz is True

    def test_today_is_holiday(self):
        with patch("fetch_data.stock") as mock_stock:
            # 오늘과 다른 날짜 반환 = 휴장일
            mock_stock.get_nearest_business_day_in_a_week.return_value = "20260101"
            date, is_biz = fetch_data.resolve_business_day(None)
        from datetime import datetime
        from fetch_data import KST
        if datetime.now(KST).strftime("%Y%m%d") != "20260101":
            assert is_biz is False

    def test_explicit_date_always_business_day(self):
        with patch("fetch_data.stock") as mock_stock:
            mock_stock.get_nearest_business_day_in_a_week.return_value = "20260504"
            date, is_biz = fetch_data.resolve_business_day("20260504")
        assert date == "20260504"
        assert is_biz is True
