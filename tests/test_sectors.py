"""sectors.classify_sector 단위 테스트."""
import pytest
from sectors import classify_sector, TICKER_TO_SECTOR, KEYWORD_RULES


class TestHardcodedMapping:
    """시총 상위 종목은 정확히 매핑되어야 함."""

    @pytest.mark.parametrize("code,name,expected", [
        ("005930", "삼성전자", "IT"),
        ("000660", "SK하이닉스", "IT"),
        ("373220", "LG에너지솔루션", "2차전지·신재생"),
        ("207940", "삼성바이오로직스", "헬스케어"),
        ("068270", "셀트리온", "헬스케어"),
        ("005380", "현대차", "경기관련소비재"),
        ("000270", "기아", "경기관련소비재"),
        ("105560", "KB금융", "금융"),
        ("055550", "신한지주", "금융"),
        ("035420", "NAVER", "커뮤니케이션"),
        ("035720", "카카오", "커뮤니케이션"),
        ("259960", "크래프톤", "게임·엔터"),
        ("005490", "POSCO홀딩스", "소재"),
        ("051910", "LG화학", "소재"),
        ("033780", "KT&G", "필수소비재"),
        ("015760", "한국전력", "유틸리티"),
        ("010950", "S-Oil", "에너지"),
        ("329180", "HD현대중공업", "산업재"),
    ])
    def test_known_tickers(self, code, name, expected):
        assert classify_sector(code, name) == expected


class TestKeywordFallback:
    """하드코딩에 없는 종목은 종목명 키워드로 추론."""

    @pytest.mark.parametrize("name,expected", [
        ("미지의제약", "헬스케어"),
        ("새로운바이오", "헬스케어"),
        ("XXX은행지주", "금융"),
        ("YYY금융지주", "금융"),
        ("ZZZ증권", "금융"),
        ("AAA화재", "금융"),
        ("BBB생명", "금융"),
        ("CCC건설", "산업재"),
        ("DDDENG", "산업재"),
        ("EEE자동차", "경기관련소비재"),
        ("FFF화학", "소재"),
        ("GGG철강", "소재"),
        ("HHH전력", "유틸리티"),
        ("III가스", "유틸리티"),
        ("JJJ게임", "게임·엔터"),
        ("KKK엔터테인먼트", "게임·엔터"),
        ("LLL반도체", "IT"),
        ("MMM디스플레이", "IT"),
        ("NNN텔레콤", "커뮤니케이션"),
        ("OOO식품", "필수소비재"),
        ("PPP리테일", "필수소비재"),
        ("QQQ백화점", "필수소비재"),
    ])
    def test_keyword_inference(self, name, expected):
        # 하드코딩에 없는 가짜 코드 사용
        assert classify_sector("999999", name) == expected


class TestEdgeCases:
    """엣지 케이스."""

    def test_completely_unknown_falls_to_etc(self):
        assert classify_sector("999999", "전혀모르는회사") == "기타"

    def test_empty_name(self):
        assert classify_sector("999999", "") == "기타"

    def test_hardcoded_priority_over_keyword(self):
        """하드코딩 매핑이 키워드 매칭보다 우선."""
        # 005930 삼성'전자' 는 키워드로는 IT지만 하드코딩으로도 IT
        # 더 명확한 케이스: 사실 동일 결과라 큰 의미 없음. 단지 하드코딩이 먼저 체크됨을 확인
        assert classify_sector("005930", "삼성전자") == TICKER_TO_SECTOR["005930"]


class TestDataQuality:
    """매핑 데이터 자체의 품질."""

    def test_no_duplicate_tickers_with_different_sectors(self):
        # TICKER_TO_SECTOR 는 dict라 중복 키 자체가 불가능 — 사전 점검만
        assert len(TICKER_TO_SECTOR) == len(set(TICKER_TO_SECTOR.keys()))

    def test_all_tickers_are_6_digits(self):
        for code in TICKER_TO_SECTOR.keys():
            assert len(code) == 6, f"코드 {code} 길이 오류"
            assert code.isdigit(), f"코드 {code} 형식 오류"

    def test_all_sectors_are_known(self):
        valid_sectors = {
            "IT", "금융", "경기관련소비재", "커뮤니케이션", "헬스케어",
            "산업재", "소재", "필수소비재", "에너지", "유틸리티", "부동산",
            "2차전지·신재생", "게임·엔터",
        }
        for code, sec in TICKER_TO_SECTOR.items():
            assert sec in valid_sectors, f"{code} 의 섹터 {sec} 가 정의 외"

    def test_keyword_rules_well_formed(self):
        for keywords, sector in KEYWORD_RULES:
            assert isinstance(keywords, tuple)
            assert len(keywords) > 0
            assert isinstance(sector, str)

class TestSectorsSourceIntegrity:
    """sectors.py 파일 자체의 정합성 검증 (dict 자연 흡수로 가려진 중복 검출)."""

    def test_no_duplicate_ticker_lines_in_source(self):
        """텍스트 레벨로 "NNNNNN": 패턴이 동일 코드에 두 번 이상 나오지 않는지."""
        import re
        from pathlib import Path
        src_path = Path(__file__).resolve().parent.parent / "ingest" / "sectors.py"
        src = src_path.read_text(encoding="utf-8")
        codes = re.findall(r'^    "(\d{6})":', src, re.MULTILINE)
        dupes = [c for c in set(codes) if codes.count(c) > 1]
        assert not dupes, f"sectors.py 에 중복 종목코드 라인 발견: {dupes}"
