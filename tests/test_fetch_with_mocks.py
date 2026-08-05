"""fetch_kospi200, resolve_business_day mocking tests (KRX Open API)."""
import pytest
from unittest.mock import patch, MagicMock
import fetch_data


@pytest.fixture(autouse=True)
def fast(monkeypatch):
    monkeypatch.setattr(fetch_data, "BACKOFF_BASE", 0.001)
    monkeypatch.setenv("KRX_AUTH_KEY", "test-key")


def make_krx_row(code, close, change_pct, mktcap):
    return {
        "ISU_SRT_CD": code,
        "TDD_CLSPRC": str(close),
        "FLUC_RT": str(change_pct),
        "MKTCAP": str(mktcap),
    }


class TestFetchKospi200:
    def test_basic(self, monkeypatch, tmp_path):
        codes = ["000660", "005930", "207940"]
        monkeypatch.setattr(fetch_data, "load_universe", lambda: codes)
        monkeypatch.setattr(fetch_data, "OUT_FILE", tmp_path / "treemap.json")

        rows_resp = [
            make_krx_row("005930", 78000, 1.30, 470_000_000_000_000),
            make_krx_row("000660", 130000, -0.61, 152_000_000_000_000),
            make_krx_row("207940", 1100000, 1.57, 72_000_000_000_000),
        ]

        with patch("fetch_data._krx_get", return_value=rows_resp):
            rows = fetch_data.fetch_kospi200("20260506")

        assert len(rows) == 3
        codes_out = sorted(r["code"] for r in rows)
        assert codes_out == ["000660", "005930", "207940"]

        s = next(r for r in rows if r["code"] == "005930")
        assert s["name"] == "삼성전자"
        assert s["value"] == 4_700_000
        assert s["price"] == 78000
        assert s["sector"] == "IT"
        assert abs(s["change"] - 1.30) < 0.01
        assert s["spark"] == [78000]

    def test_skips_zero_marcap(self, monkeypatch, tmp_path):
        codes = ["005930", "000660"]
        monkeypatch.setattr(fetch_data, "load_universe", lambda: codes)
        monkeypatch.setattr(fetch_data, "OUT_FILE", tmp_path / "treemap.json")

        rows_resp = [
            make_krx_row("005930", 78000, 1.30, 470_000_000_000_000),
            make_krx_row("000660", 130000, -0.61, 0),
        ]

        with patch("fetch_data._krx_get", return_value=rows_resp):
            rows = fetch_data.fetch_kospi200("20260506")

        assert len(rows) == 1
        assert rows[0]["code"] == "005930"

    def test_excludes_outlier_change_pct(self, monkeypatch, tmp_path):
        # 이상치 서킷브레이커(5%)를 건드리지 않도록 충분히 큰 유니버스 사용
        codes = [f"{i:06d}" for i in range(30)]
        codes[0] = "005930"
        codes[1] = "000660"
        monkeypatch.setattr(fetch_data, "load_universe", lambda: codes)
        monkeypatch.setattr(fetch_data, "OUT_FILE", tmp_path / "treemap.json")

        rows_resp = [
            make_krx_row("005930", 78000, 1.30, 470_000_000_000_000),
            make_krx_row("000660", 130000, 45.0, 152_000_000_000_000),
        ]

        with patch("fetch_data._krx_get", return_value=rows_resp):
            rows = fetch_data.fetch_kospi200("20260506")

        assert len(rows) == 1
        assert rows[0]["code"] == "005930"

    def test_retry_on_krx_failure(self, monkeypatch, tmp_path):
        codes = ["005930"]
        monkeypatch.setattr(fetch_data, "load_universe", lambda: codes)
        monkeypatch.setattr(fetch_data, "OUT_FILE", tmp_path / "treemap.json")

        rows_resp = [make_krx_row("005930", 78000, 1.30, 470_000_000_000_000)]
        call_count = [0]

        def flaky_requests_get(url, params=None, headers=None, timeout=None):
            call_count[0] += 1
            if call_count[0] < 2:
                raise ConnectionError("flaky")
            resp = MagicMock()
            resp.status_code = 200
            resp.json.return_value = {"OutBlock_1": rows_resp}
            return resp

        with patch("fetch_data.requests.get", side_effect=flaky_requests_get):
            rows = fetch_data.fetch_kospi200("20260506")

        assert len(rows) == 1
        assert call_count[0] == 2

    def test_spark_rolls_forward_from_previous_snapshot(self, monkeypatch, tmp_path):
        import json

        codes = ["005930"]
        monkeypatch.setattr(fetch_data, "load_universe", lambda: codes)
        out_file = tmp_path / "treemap.json"
        monkeypatch.setattr(fetch_data, "OUT_FILE", out_file)

        prev_tree = {
            "as_of": "20260505",
            "children": [
                {"name": "IT", "children": [
                    {"code": "005930", "name": "삼성전자", "spark": [76000, 77000, 77500]}
                ]}
            ],
        }
        out_file.write_text(json.dumps(prev_tree), encoding="utf-8")

        rows_resp = [make_krx_row("005930", 78000, 0.65, 470_000_000_000_000)]
        with patch("fetch_data._krx_get", return_value=rows_resp):
            rows = fetch_data.fetch_kospi200("20260506")

        assert rows[0]["spark"] == [76000, 77000, 77500, 78000]


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


class TestKoreanNames:
    def test_resolve_name_known(self):
        assert fetch_data.resolve_name("005930") == "삼성전자"

    def test_resolve_name_unknown(self):
        assert fetch_data.resolve_name("999999") == "999999"
