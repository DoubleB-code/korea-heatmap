"""fetch_kospi200, resolve_business_day 모킹 테스트 (FinanceDataReader)."""
import pytest
import pandas as pd
from unittest.mock import patch
from datetime import datetime
import fetch_data


@pytest.fixture(autouse=True)
def fast(monkeypatch):
    monkeypatch.setattr(fetch_data, "BACKOFF_BASE", 0.001)
    monkeypatch.setattr(fetch_data, "PER_REQUEST_DELAY", 0.0)


def make_listings():
    """StockListing('KOSPI200') 모킹."""
    return pd.DataFrame({
        "Code": ["005930", "000660", "207940"],
        "Name": ["삼성전자", "SK하이닉스", "삼성바이오로직스"],
    })


def make_kospi_all():
    """StockListing('KOSPI') 모킹 - 시총·등락률·종가 포함."""
    return pd.DataFrame({
        "Code": ["005930", "000660", "207940", "999999"],  # 999999는 KOSPI200 미포함
        "Name": ["삼성전자", "SK하이닉스", "삼성바이오로직스", "기타종목"],
        "Marcap": [470_000_000_000_000, 152_000_000_000_000, 72_000_000_000_000, 1_000_000_000_000],
        "ChagesRatio": [1.23, -0.61, 1.55, 0.5],
        "Close": [78000, 130000, 1100000, 5000],
    })


class TestFetchKospi200:
    def test_basic(self):
        with patch("fetch_data.fdr.StockListing") as mock_sl:
            mock_sl.side_effect = lambda x: make_listings() if x == "KOSPI200" else make_kospi_all()
            rows = fetch_data.fetch_kospi200("20260506")
        assert len(rows) == 3  # 999999 제외
        codes = [r["code"] for r in rows]
        assert "005930" in codes
        assert "999999" not in codes
        s = next(r for r in rows if r["code"] == "005930")
        assert s["name"] == "삼성전자"
        assert s["value"] == 4_700_000  # 시총 → 억원
        assert s["change"] == 1.23
        assert s["price"] == 78000
        assert s["sector"] == "IT"

    def test_skips_zero_cap(self):
        all_df = make_kospi_all()
        all_df.loc[0, "Marcap"] = 0  # 삼성전자 시총 0
        with patch("fetch_data.fdr.StockListing") as mock_sl:
            mock_sl.side_effect = lambda x: make_listings() if x == "KOSPI200" else all_df
            rows = fetch_data.fetch_kospi200("20260506")
        assert len(rows) == 2

    def test_retry_on_listing_failure(self):
        call_count = [0]
        def flaky(x):
            call_count[0] += 1
            if x == "KOSPI200" and call_count[0] < 2:
                raise ConnectionError("flaky")
            return make_listings() if x == "KOSPI200" else make_kospi_all()
        with patch("fetch_data.fdr.StockListing", side_effect=flaky):
            rows = fetch_data.fetch_kospi200("20260506")
        assert len(rows) == 3


class TestResolveBusinessDay:
    def test_explicit_date(self):
        date, biz = fetch_data.resolve_business_day("20260504")
        assert date == "20260504"
        assert biz is True

    def test_today_no_external_call(self):
        # 외부 API 호출 없이 로컬 calendar 만 사용
        date, biz = fetch_data.resolve_business_day(None)
        assert len(date) == 8 and date.isdigit()
