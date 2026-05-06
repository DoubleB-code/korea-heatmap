"""fetch_kospi200, resolve_business_day mocking tests (yfinance)."""
import pytest
import pandas as pd
from unittest.mock import patch, MagicMock
import fetch_data


@pytest.fixture(autouse=True)
def fast(monkeypatch):
    monkeypatch.setattr(fetch_data, "BACKOFF_BASE", 0.001)
    monkeypatch.setattr(fetch_data, "PER_REQUEST_DELAY", 0.0)
    monkeypatch.setattr(fetch_data, "MARCAP_WORKERS", 2)


def make_yf_download_df(codes):
    """Mock yf.download() multi-ticker MultiIndex DataFrame."""
    dates = pd.date_range("2026-04-30", periods=5)
    cols = []
    data = {}
    for c in codes:
        sym = f"{c}.KS"
        for col in ["Open", "High", "Low", "Close", "Volume"]:
            cols.append((sym, col))
            if col == "Close":
                if c == "005930":
                    data[(sym, col)] = [76000, 76500, 77000, 77000, 78000]
                elif c == "000660":
                    data[(sym, col)] = [131000, 130800, 131200, 130800, 130000]
                elif c == "207940":
                    data[(sym, col)] = [1080000, 1085000, 1090000, 1083000, 1100000]
                else:
                    data[(sym, col)] = [1000, 1010, 1020, 1015, 1020]
            else:
                data[(sym, col)] = [0] * 5
    multi = pd.MultiIndex.from_tuples(cols)
    df = pd.DataFrame(data, index=dates, columns=multi)
    return df


def make_fast_info(cap):
    fi = MagicMock()
    fi.get = MagicMock(return_value=cap)
    return fi


class TestFetchKospi200:
    def test_basic(self, monkeypatch):
        codes = ["000660", "005930", "207940"]
        monkeypatch.setattr(fetch_data, "load_universe", lambda: codes)

        df = make_yf_download_df(codes)
        marcap_map = {
            "005930": 470_000_000_000_000,
            "000660": 152_000_000_000_000,
            "207940": 72_000_000_000_000,
        }

        def fake_ticker(sym):
            t = MagicMock()
            code = sym.replace(".KS", "")
            t.fast_info = make_fast_info(marcap_map.get(code, 0))
            return t

        with patch("fetch_data.yf.download", return_value=df), \
             patch("fetch_data.yf.Ticker", side_effect=fake_ticker):
            rows = fetch_data.fetch_kospi200("20260506")

        assert len(rows) == 3
        codes_out = sorted(r["code"] for r in rows)
        assert codes_out == ["000660", "005930", "207940"]

        s = next(r for r in rows if r["code"] == "005930")
        assert s["name"] == "삼성전자"
        assert s["value"] == 4_700_000
        assert s["price"] == 78000
        assert s["sector"] == "IT"
        assert abs(s["change"] - 1.30) < 0.05

    def test_skips_zero_marcap(self, monkeypatch):
        codes = ["005930", "000660"]
        monkeypatch.setattr(fetch_data, "load_universe", lambda: codes)

        df = make_yf_download_df(codes)

        def fake_ticker(sym):
            t = MagicMock()
            cap = 470_000_000_000_000 if "005930" in sym else 0
            t.fast_info = make_fast_info(cap)
            return t

        with patch("fetch_data.yf.download", return_value=df), \
             patch("fetch_data.yf.Ticker", side_effect=fake_ticker):
            rows = fetch_data.fetch_kospi200("20260506")

        assert len(rows) == 1
        assert rows[0]["code"] == "005930"

    def test_retry_on_yf_download_failure(self, monkeypatch):
        codes = ["005930"]
        monkeypatch.setattr(fetch_data, "load_universe", lambda: codes)

        df = make_yf_download_df(codes)
        marcap = 470_000_000_000_000
        call_count = [0]

        def flaky_download(*args, **kwargs):
            call_count[0] += 1
            if call_count[0] < 2:
                raise ConnectionError("flaky")
            return df

        def fake_ticker(sym):
            t = MagicMock()
            t.fast_info = make_fast_info(marcap)
            return t

        with patch("fetch_data.yf.download", side_effect=flaky_download), \
             patch("fetch_data.yf.Ticker", side_effect=fake_ticker):
            rows = fetch_data.fetch_kospi200("20260506")

        assert len(rows) == 1
        assert call_count[0] == 2


class TestResolveBusinessDay:
    def test_explicit_date(self):
        date, biz = fetch_data.resolve_business_day("20260504")
        assert date == "20260504"
        assert biz is True

    def test_today_no_external_call(self):
        date, biz = fetch_data.resolve_business_day(None)
        assert len(date) == 8 and date.isdigit()


class TestUniverse:
    def test_load_universe_returns_codes(self):
        codes = fetch_data.load_universe()
        assert len(codes) > 100
        assert all(len(c) == 6 and c.isdigit() for c in codes)

    def test_to_yf_symbol(self):
        assert fetch_data.to_yf_symbol("005930") == "005930.KS"
        assert fetch_data.to_yf_symbol("5930") == "005930.KS"


class TestKoreanNames:
    def test_resolve_name_known(self):
        assert fetch_data.resolve_name("005930") == "삼성전자"

    def test_resolve_name_unknown(self):
        assert fetch_data.resolve_name("999999") == "999999"
