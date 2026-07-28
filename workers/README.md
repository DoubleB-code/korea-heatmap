# KOSPI 예측 게임 — API Workers

코리아 히트맵 베팅 게임의 백엔드 API. Cloudflare Workers + D1 (SQLite).

## 빠른 시작

```bash
# 1. 의존성 설치
cd workers
npm install

# 2. Cloudflare 로그인
npx wrangler login

# 3. D1 데이터베이스 생성
npx wrangler d1 create kospi-bets

# → 출력 예시:
# [[d1_databases]]
# binding = "DB"
# database_name = "kospi-bets"
# database_id = "abc123-def456-..."   ← 이 값을 복사

# 4. wrangler.toml 의 database_id 값을 위 값으로 교체

# 5. 스키마 적용 (로컬)
npm run db:migrate

# 6. 스키마 적용 (배포본 — 실제 사용)
npm run db:migrate:remote

# 7. 로컬 테스트
npm run dev

# 8. 배포
npm run deploy
```

배포 후 도메인: `https://kospi-bets-api.<your-subdomain>.workers.dev`

## 1차 (현재) — 구현된 엔드포인트

| Method | Path | 설명 |
|---|---|---|
| `GET` | `/api/health` | 헬스체크 |
| `POST` | `/api/user/init` | 익명 사용자 생성/복귀 |
| `GET` | `/api/me` | 내 정보 + 통계 + 오늘 한도 |
| `GET` | `/api/me/history?limit=20` | 내 베팅 이력 |

## 검증 (배포 후 curl)

```bash
API_URL="https://kospi-bets-api.<your>.workers.dev"

# 1. 헬스체크
curl $API_URL/api/health
# → {"ok":true,"ts":...}

# 2. 익명 사용자 생성 (쿠키 저장)
curl -c cookies.txt -X POST $API_URL/api/user/init
# → {"user":{"id":"...","nickname":"현명한 두꺼비 42","points":1000,...},"isNew":true}

# 3. 내 정보 조회 (쿠키 재사용)
curl -b cookies.txt $API_URL/api/me
# → {"user":{...},"stats":{...},"today":{"used":0,"limit":3,"remaining":3}}

# 4. 이력 조회 (아직 비어있음)
curl -b cookies.txt $API_URL/api/me/history
# → {"bets":[]}
```

## 보안 메모

- 쿠키: `HttpOnly` + `Secure` + `SameSite=None` (cross-site cookie 필수)
- IP 일 신규 가입 한도: 5개 (어뷰징 방어)
- IP는 SHA256 hash로만 저장 (privacy)
- 쿠키 도메인은 `.workers.dev` 가 아니라면 명시적 도메인 설정 가능

## 2차 (다음) 예정 항목

- `POST /api/bets` — 베팅 제출
- `GET /api/bets/today` — 오늘 추첨 종목 (결정적 시드)
- `GET /api/leaderboard?period=daily|weekly|monthly`
- Yahoo Finance 직접 호출 (yfinance 대체)

## 3차 예정

- `scheduled` Cron 정산 (매일 17:30 KST)
- 프론트엔드 통합 (bet.html → API 호출 모드)
- Cloudflare Turnstile (봇 차단)
- 종목 추첨 결정적 시드 (user_id + date)

## 디렉토리 구조

```
workers/
├── wrangler.toml          # Workers 설정
├── package.json
├── tsconfig.json
├── README.md
├── migrations/
│   └── 0001_init.sql      # D1 초기 스키마 + 시드
└── src/
    ├── index.ts           # 라우터
    ├── types.ts           # 공통 타입
    ├── lib/
    │   ├── responses.ts   # JSON + CORS 헬퍼
    │   ├── kst.ts         # KST 시간 유틸
    │   └── auth.ts        # 익명 쿠키 인증
    └── handlers/
        └── user.ts        # /api/user/* /api/me/*
```

## 로그 / 디버깅

```bash
# 실시간 로그
npm run tail

# D1 직접 쿼리
npx wrangler d1 execute kospi-bets --remote --command "SELECT COUNT(*) FROM users"
```
