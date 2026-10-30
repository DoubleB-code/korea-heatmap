# 코리아 히트맵 (Korea Heatmap)

> 한국 KOSPI 200 종목을 시가총액 가중 트리맵으로 한눈에 확인. Finviz의 한국 시장 버전.

![Stack](https://img.shields.io/badge/python-3.11+-blue) ![Stack](https://img.shields.io/badge/d3-v7-orange) ![License](https://img.shields.io/badge/license-MIT-green) ![Status](https://img.shields.io/badge/status-production-green)

---

## 핵심 특징

- **시총 가중 트리맵**: 박스 크기 = 시가총액, 색상 = 등락률 (파스텔 11단계 그라데이션)
- **호버 인터랙션**: 종목 sparkline + 같은 섹터 peer 5개 동시 비교
- **종목 클릭 → 네이버 금융 이동**
- **포트폴리오 사이드 패널**: 평단가·수량 입력 → 평가손익·수익률 자동 계산 (localStorage 저장)
- **자동 갱신**: 매 영업일 KST 09:30 / 13:00 / 16:00 (GitHub Actions cron)
- **광고 슬롯**: 좌측 사이드바 160×600 + 160×250 (AdSense / 카카오 애드핏 연결 대기)
- **보안 7층**: CSP, HTTP 헤더, CodeQL, Dependabot, 의존성 핀, XSS escape, 무결성 검증
- **SEO 최적화**: Noto Sans KR, OG 메타데이터, robots.txt, sitemap

---

## 운영 시작 가이드 → `LAUNCH.md` 참고

처음 출시할 때는 [LAUNCH.md](./LAUNCH.md)의 단계별 명령어 가이드를 따라하세요. 약 30분 내 출시 가능.

---

## 프로젝트 구조

```
kospi-heatmap/
├── ingest/
│   ├── run.py              # 진입점 (CLI)
│   ├── fetch_data.py       # PyKRX 수집 + 재시도 + KST 타임존
│   ├── hierarchy.py        # 트리 구축 + 무결성 검증
│   └── sectors.py          # 종목→섹터 매핑 (114개 큐레이션)
├── tests/                  # pytest 95개
├── web/
│   ├── index.html          # 코리아 히트맵 페이지
│   ├── _headers            # Cloudflare Pages 보안 HTTP 헤더
│   ├── robots.txt
│   └── data/treemap.json   # 자동 갱신 (커밋됨)
├── .github/
│   ├── workflows/
│   │   ├── update.yml      # 일 3회 자동 갱신
│   │   └── codeql.yml      # 보안 스캔
│   └── dependabot.yml
├── scripts/run_local.sh    # 로컬 실행 헬퍼
├── requirements.txt        # 핀 버전
├── SECURITY.md             # 보안 정책
└── LAUNCH.md               # 운영 출시 가이드
```

---

## 로컬 실행 (3분)

```bash
git clone https://github.com/<당신ID>/korea-heatmap.git
cd korea-heatmap
bash scripts/run_local.sh
```

브라우저에서 http://localhost:8080 열면 끝.

---

## 자동 갱신 스케줄

| 시점 (KST) | UTC cron | 의미 |
|---|---|---|
| 09:30 월~금 | `30 0 * * 1-5` | 시초가 안정화 직후 |
| 13:00 월~금 | `0 4 * * 1-5` | 점심 마감 시점 |
| 16:00 월~금 | `0 7 * * 1-5` | 정규장 마감 + 종가 동시호가 반영 |

휴장일 자동 SKIP, 재시도 3회 + 지수 백오프, 무결성 검증 실패 시 직전 정상 스냅샷 유지.

---

## 보안 정책 → `SECURITY.md` 참고

- HTTP 보안 헤더 (CSP, HSTS, X-Frame-Options, Permissions-Policy 등)
- CodeQL 자동 정적 분석 (주 1회 + push/PR)
- Dependabot 의존성 보안 패치
- requirements.txt 버전 핀
- XSS escape 적용 (모든 동적 텍스트)
- 무결성 게이트 (validate_tree + validate_output.py)

---

## 향후 로드맵

- [ ] KOSDAQ 추가 (`get_index_portfolio_deposit_file("2001")`)
- [ ] 1주·1개월·YTD 기간 토글
- [ ] OG 이미지 자동 생성 (Playwright + canvas)
- [ ] 종목 상세 페이지 동적 생성 (200개 SEO 페이지)
- [ ] 실시간 시세 (KIS Open API 마이그레이션)
- [ ] 모바일 최적화
- [ ] 알림 (등락률·거래량 임계치 텔레그램)

---

## 라이선스

- 코드: MIT
- 데이터: KRX 공개 데이터를 PyKRX 라이브러리로 수집
- 본 도구는 정보 제공 목적이며, 투자 판단의 근거가 될 수 없음
