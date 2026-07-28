"""
KOSPI 200 일별 스냅샷 수집 (yfinance / Yahoo Finance 기반).

PyKRX -> FinanceDataReader -> yfinance 전환 이력:
- PyKRX: KRX가 GitHub Actions IP를 차단해서 작동 불가
- FinanceDataReader: 한국 종목에 대해 내부적으로 KRX/Naver fchart 호출 -> 동일 차단 문제
- yfinance: 100% Yahoo Finance -- 검증된 GitHub Actions 호환

Universe (200 종목):
- sectors.TICKER_TO_SECTOR 의 keys 가 KOSPI 200 ticker 리스트 (분기 1회 수동 갱신)

종료 코드:
    0  성공 또는 휴장일 SKIP
    1  네트워크 장애
    2  데이터 무결성 위반
"""
from __future__ import annotations

import logging
import time
from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import datetime, timezone, timedelta
from pathlib import Path

import pandas as pd
import yfinance as yf

from sectors import TICKER_TO_SECTOR, classify_sector

KST = timezone(timedelta(hours=9))

PROJECT_ROOT = Path(__file__).resolve().parent.parent
OUT_DIR = PROJECT_ROOT / "web" / "data"
OUT_DIR.mkdir(parents=True, exist_ok=True)

OUT_FILE = OUT_DIR / "treemap.json"
OUT_PRETTY = OUT_DIR / "treemap.pretty.json"
META_FILE = OUT_DIR / "_meta.json"

MIN_STOCKS = 150
MAX_CHANGE_PCT = 30.0
MAX_RETRIES = 3
BACKOFF_BASE = 1.0
PER_REQUEST_DELAY = 0.0
MARCAP_WORKERS = 16

KOREAN_NAMES = {
    "005930": "삼성전자",
    "000660": "SK하이닉스",
    "006400": "삼성SDI",
    "066570": "LG전자",
    "042700": "한미반도체",
    "009150": "삼성전기",
    "034730": "SK",
    "000990": "DB하이텍",
    "012510": "더존비즈온",
    "240810": "원익IPS",
    "108860": "셀바스AI",
    "036930": "주성엔지니어링",
    "058470": "리노공업",
    "095340": "ISC",
    "131970": "두산테스나",
    "402340": "SK스퀘어",
    "373220": "LG에너지솔루션",
    "247540": "에코프로비엠",
    "086520": "에코프로",
    "003670": "포스코퓨처엠",
    "000270": "기아",
    "096770": "SK이노베이션",
    "105560": "KB금융",
    "055550": "신한지주",
    "086790": "하나금융지주",
    "316140": "우리금융지주",
    "138040": "메리츠금융지주",
    "032830": "삼성생명",
    "323410": "카카오뱅크",
    "001450": "현대해상",
    "029780": "삼성카드",
    "005830": "DB손해보험",
    "088350": "한화생명",
    "024110": "기업은행",
    "139130": "DGB금융지주",
    "175330": "JB금융지주",
    "071050": "한국금융지주",
    "030610": "교보증권",
    "008560": "메리츠증권",
    "039490": "키움증권",
    "016360": "삼성증권",
    "006800": "미래에셋증권",
    "377300": "카카오페이",
    "005380": "현대차",
    "012330": "현대모비스",
    "010620": "현대미포조선",
    "204320": "HL만도",
    "011210": "현대위아",
    "018880": "한온시스템",
    "088980": "맥쿼리인프라",
    "035420": "NAVER",
    "035720": "카카오",
    "017670": "SK텔레콤",
    "030200": "KT",
    "032640": "LG유플러스",
    "079160": "CJ",
    "259960": "크래프톤",
    "036570": "엔씨소프트",
    "251270": "넷마블",
    "112040": "위메이드",
    "194480": "데브시스터즈",
    "352820": "하이브",
    "041510": "SM",
    "035900": "JYP",
    "122870": "와이지엔터테인먼트",
    "207940": "삼성바이오로직스",
    "068270": "셀트리온",
    "326030": "SK바이오팜",
    "128940": "한미약품",
    "145020": "휴젤",
    "000100": "유한양행",
    "069620": "대웅제약",
    "185750": "종근당",
    "009420": "한올바이오파마",
    "028050": "삼성E&A",
    "329180": "HD현대중공업",
    "012450": "한화에어로스페이스",
    "034020": "두산에너빌리티",
    "010140": "삼성중공업",
    "042660": "한화오션",
    "028260": "삼성물산",
    "011200": "HMM",
    "086280": "현대글로비스",
    "180640": "한진칼",
    "047040": "대우건설",
    "006360": "GS건설",
    "000720": "현대건설",
    "003490": "대한항공",
    "020560": "아시아나항공",
    "267260": "HD현대일렉트릭",
    "005490": "POSCO홀딩스",
    "051910": "LG화학",
    "010130": "고려아연",
    "011170": "롯데케미칼",
    "001230": "동국홀딩스",
    "004020": "현대제철",
    "003030": "세아제강지주",
    "009830": "한화솔루션",
    "078930": "GS",
    "033780": "KT&G",
    "097950": "CJ제일제당",
    "271560": "오리온",
    "001040": "CJ",
    "282330": "BGF리테일",
    "023530": "롯데쇼핑",
    "139480": "이마트",
    "057050": "현대홈쇼핑",
    "069960": "현대백화점",
    "010950": "S-Oil",
    "267250": "HD현대",
    "015760": "한국전력",
    "036460": "한국가스공사",
    "117930": "한진중공업홀딩스",
    "267290": "경동도시가스",
    "161390": "한국타이어앤테크놀로지",
    "002350": "넥센타이어",
    "060980": "HL홀딩스",
    "051900": "LG생활건강",
    "090430": "아모레퍼시픽",
    "002790": "아모레G",
    "161890": "한국콜마",
    "192820": "코스맥스",
    "021240": "코웨이",
    "111770": "영원무역",
    "081660": "휠라홀딩스",
    "383220": "F&F",
    "020000": "한섬",
    "008770": "호텔신라",
    "035250": "강원랜드",
    "114090": "GKL",
    "031430": "신세계인터내셔날",
    "215000": "골프존",
    "005180": "빙그레",
    "004370": "농심",
    "049770": "동원F&B",
    "001680": "대상",
    "267980": "매일유업",
    "017810": "풀무원",
    "026960": "동서",
    "004170": "신세계",
    "007070": "GS리테일",
    "051500": "CJ프레시웨이",
    "047810": "한국항공우주",
    "009540": "HD한국조선해양",
    "272210": "한화시스템",
    "000880": "한화",
    "000150": "두산",
    "241560": "두산밥캣",
    "454910": "두산로보틱스",
    "042670": "HD현대인프라코어",
    "298040": "효성중공업",
    "004800": "효성",
    "012750": "에스원",
    "000120": "CJ대한통운",
    "005430": "한국공항",
    "298050": "효성첨단소재",
    "298020": "효성티앤씨",
    "120110": "코오롱인더",
    "011790": "SKC",
    "014680": "한솔케미칼",
    "456040": "OCI홀딩스",
    "005070": "코스모신소재",
    "002380": "KCC",
    "344820": "KCC글라스",
    "093370": "후성",
    "000670": "영풍",
    "103140": "풍산",
    "034220": "LG디스플레이",
    "011070": "LG이노텍",
    "005290": "동진쎄미켐",
    "357780": "솔브레인",
    "074600": "원익큐엔씨",
    "064760": "티씨케이",
    "403870": "HPSP",
    "166090": "하나머티리얼즈",
    "189300": "인텔리안테크",
    "263750": "펄어비스",
    "293490": "카카오게임즈",
    "035760": "CJ",
    "253450": "스튜디오드래곤",
    "008930": "한미사이언스",
    "086900": "메디톡스",
    "195940": "HK이노엔",
    "006280": "녹십자",
    "086450": "동국제약",
    "003850": "보령",
    "196170": "알테오젠",
    "214150": "클래시스",
    "141080": "리가켐바이오",
    "170900": "동아에스티",
    "000640": "동아쏘시오홀딩스",
    "138930": "BNK금융지주",
    "003690": "코리안리",
    "066970": "엘앤에프",
    "336260": "두산퓨얼셀",
    "071320": "한국지역난방공사",
    "004690": "삼천리",
    "001120": "LX인터내셔널",
    "001740": "SK네트웍스",
}

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s %(levelname)-7s %(message)s",
    datefmt="%H:%M:%S",
)
log = logging.getLogger("kospi-heatmap")


def with_retry(fn, *args, _label="", **kwargs):
    last_exc = None
    for attempt in range(1, MAX_RETRIES + 1):
        try:
            return fn(*args, **kwargs)
        except Exception as exc:
            last_exc = exc
            wait = BACKOFF_BASE * (2 ** (attempt - 1))
            log.warning(
                "%s 호출 실패 (시도 %d/%d): %s — %.1fs 대기 후 재시도",
                _label or fn.__name__, attempt, MAX_RETRIES, exc, wait,
            )
            if attempt < MAX_RETRIES:
                time.sleep(wait)
    raise RuntimeError(
        f"{_label or fn.__name__} 재시도 {MAX_RETRIES}회 모두 실패: {last_exc}"
    ) from last_exc


def _local_business_day_fallback():
    dt = datetime.now(KST)
    while dt.weekday() >= 5:
        dt -= timedelta(days=1)
    return dt.strftime("%Y%m%d")


def resolve_business_day(requested):
    today = datetime.now(KST).strftime("%Y%m%d")
    if requested:
        return requested, True
    fallback = _local_business_day_fallback()
    return fallback, fallback == today


def load_universe():
    codes = sorted(TICKER_TO_SECTOR.keys())
    log.info("Universe loaded: %d codes (sectors.TICKER_TO_SECTOR)", len(codes))
    return codes


def to_yf_symbol(code):
    return f"{code.zfill(6)}.KS"


def fetch_prices(codes):
    """가격 + D-1 변동률 + 30일 sparkline. 일봉 45일 윈도우 (영업일 30일+ 확보)."""
    symbols = [to_yf_symbol(c) for c in codes]
    # 30일 영업일 sparkline + 휴장일 버퍼 → 45일 캘린더 윈도우
    end_date = datetime.now(KST).date() + timedelta(days=1)
    start_date = end_date - timedelta(days=45)
    log.info("yf.download: %d symbols, period=%s..%s (30일 sparkline 포함)", len(symbols), start_date, end_date)

    df = with_retry(
        yf.download,
        tickers=" ".join(symbols),
        start=str(start_date),
        end=str(end_date),
        interval="1d",
        group_by="ticker",
        threads=True,
        progress=False,
        auto_adjust=False,
        _label="yf.download",
    )

    if df is None or df.empty:
        raise RuntimeError("yf.download empty result")

    out = {}
    # 진단용 watch list: 이 종목들은 항상 (날짜, 종가) 시퀀스 출력
    DIAG_WATCH = {"005930", "011790", "336260", "028260", "006800", "000660"}
    sample_logged = 0
    for code in codes:
        sym = to_yf_symbol(code)
        try:
            if isinstance(df.columns, pd.MultiIndex):
                sub = df[sym]
            else:
                sub = df
            closes = sub["Close"].dropna()
            if len(closes) < 2:
                continue

            today_close = float(closes.iloc[-1])
            prev_close = float(closes.iloc[-2])
            if prev_close <= 0:
                continue
            change = (today_close - prev_close) / prev_close * 100

            # 진단 로그:
            # 1) 처음 3종목 항상 출력
            # 2) 의심 watch list 항상 출력
            # 3) |변동률| > 10% 종목도 출력
            should_log = (
                sample_logged < 3
                or code in DIAG_WATCH
                or abs(change) > 10
            )
            if should_log:
                tail = closes.tail(5)
                log.info(
                    "  diag %s (ch=%+.2f%%): %s",
                    code, change,
                    [(str(d.date()), round(float(v), 2)) for d, v in tail.items()],
                )
                sample_logged += 1

            # 30일 sparkline (마지막 30개 영업일 종가)
            spark_pts = [int(v) for v in closes.tail(30).tolist() if v > 0]

            out[code] = {
                "today_close": today_close,
                "prev_close": prev_close,
                "change_pct": round(change, 2),
                "spark": spark_pts,
            }
        except (KeyError, IndexError, ValueError):
            continue

    log.info("Prices collected: %d/%d", len(out), len(codes))
    return out


def _fetch_one_marcap(code):
    sym = to_yf_symbol(code)
    try:
        t = yf.Ticker(sym)
        fi = t.fast_info
        cap = None
        if hasattr(fi, "get"):
            cap = fi.get("market_cap") or fi.get("marketCap")
        else:
            cap = getattr(fi, "market_cap", None) or getattr(fi, "marketCap", None)
        return code, int(cap) if cap else 0
    except Exception:
        return code, 0


def fetch_marcaps(codes):
    log.info("Marcap parallel fetch: %d codes (workers=%d)", len(codes), MARCAP_WORKERS)
    out = {}
    with ThreadPoolExecutor(max_workers=MARCAP_WORKERS) as ex:
        futures = {ex.submit(_fetch_one_marcap, c): c for c in codes}
        for fut in as_completed(futures):
            code, cap = fut.result()
            if cap > 0:
                out[code] = cap
    log.info("Marcap collected: %d/%d", len(out), len(codes))
    return out


def resolve_name(code):
    return KOREAN_NAMES.get(code, code)


def fetch_kospi200(date):
    log.info("Reference date: %s (yfinance)", date)

    codes = load_universe()
    prices = fetch_prices(codes)
    if not prices:
        raise RuntimeError("No prices collected -- Yahoo Finance response error")

    marcaps = fetch_marcaps(codes)
    if not marcaps:
        raise RuntimeError("No marcaps collected -- Yahoo Finance fast_info error")

    rows = []
    skipped = 0
    for code in codes:
        if code not in prices or code not in marcaps:
            skipped += 1
            continue
        p = prices[code]
        cap = marcaps[code]
        if cap <= 0:
            skipped += 1
            continue

        if abs(p["change_pct"]) > MAX_CHANGE_PCT:
            log.warning("Outlier excluded: %s change %+.2f%%", code, p["change_pct"])
            skipped += 1
            continue

        name = resolve_name(code)
        row = {
            "code": code,
            "name": name,
            "value": cap // 100_000_000,
            "change": p["change_pct"],
            "sector": classify_sector(code, name),
            "price": int(p["today_close"]),
            "spark": p.get("spark", []),
        }
        rows.append(row)

    log.info("Collection complete: %d stocks (skipped %d)", len(rows), skipped)
    return rows
