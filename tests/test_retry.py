"""fetch_data.with_retry 재시도 로직 테스트."""
import time
import pytest
import fetch_data
from fetch_data import with_retry


@pytest.fixture(autouse=True)
def fast_backoff(monkeypatch):
    """테스트 속도를 위해 백오프 1ms 로 단축."""
    monkeypatch.setattr(fetch_data, "BACKOFF_BASE", 0.001)


class TestRetrySuccess:
    def test_succeeds_on_first_attempt(self):
        calls = []
        def fn():
            calls.append(1)
            return "ok"
        assert with_retry(fn) == "ok"
        assert len(calls) == 1

    def test_succeeds_on_second_attempt(self):
        calls = []
        def fn():
            calls.append(1)
            if len(calls) < 2:
                raise ConnectionError("transient")
            return "ok"
        assert with_retry(fn) == "ok"
        assert len(calls) == 2

    def test_succeeds_on_third_attempt(self):
        calls = []
        def fn():
            calls.append(1)
            if len(calls) < 3:
                raise TimeoutError("transient")
            return "ok"
        assert with_retry(fn) == "ok"
        assert len(calls) == 3


class TestRetryFailure:
    def test_raises_after_max_retries(self):
        calls = []
        def fn():
            calls.append(1)
            raise ConnectionError("permanent")
        with pytest.raises(RuntimeError, match="재시도"):
            with_retry(fn)
        assert len(calls) == 3  # MAX_RETRIES

    def test_passes_through_args_kwargs(self):
        def fn(a, b=2):
            return a + b
        assert with_retry(fn, 1, b=3) == 4

    def test_label_in_error_message(self):
        def fn():
            raise ValueError("boom")
        with pytest.raises(RuntimeError, match="my_op"):
            with_retry(fn, _label="my_op")
