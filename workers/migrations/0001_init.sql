-- ════════════════════════════════════════════════════════════
-- KOSPI 예측 게임 — 초기 스키마
-- ════════════════════════════════════════════════════════════
-- 적용:
--   wrangler d1 execute kospi-bets --file=migrations/0001_init.sql           (로컬)
--   wrangler d1 execute kospi-bets --remote --file=migrations/0001_init.sql  (배포본)
-- ════════════════════════════════════════════════════════════

-- ────────────────────────────────────────
-- users: 익명 사용자
-- ────────────────────────────────────────
CREATE TABLE IF NOT EXISTS users (
  id            TEXT PRIMARY KEY,                  -- UUID v4
  nickname      TEXT NOT NULL,                     -- 자동생성 (예: "현명한_두꺼비_42")
  created_at    INTEGER NOT NULL,                  -- unix sec
  last_seen_at  INTEGER NOT NULL,
  points        INTEGER NOT NULL DEFAULT 1000,
  total_bets    INTEGER NOT NULL DEFAULT 0,
  total_wins    INTEGER NOT NULL DEFAULT 0,
  total_voids   INTEGER NOT NULL DEFAULT 0,
  streak_days   INTEGER NOT NULL DEFAULT 0,        -- 연속 베팅 일수
  last_bet_date TEXT,                              -- YYYY-MM-DD
  banned        INTEGER NOT NULL DEFAULT 0         -- 1=차단 (어뷰징)
);

CREATE INDEX IF NOT EXISTS idx_users_last_seen ON users(last_seen_at DESC);
CREATE INDEX IF NOT EXISTS idx_users_points ON users(points DESC) WHERE banned = 0;

-- ────────────────────────────────────────
-- bets: 베팅 (정산 전/후 모두)
-- ────────────────────────────────────────
CREATE TABLE IF NOT EXISTS bets (
  id                 INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id            TEXT NOT NULL,
  ticker             TEXT NOT NULL,                -- 종목코드 6자리
  ticker_name        TEXT NOT NULL,                -- 종목명 (정산 시점 스냅샷)
  target_date        TEXT NOT NULL,                -- YYYY-MM-DD (다음 영업일)
  direction          TEXT NOT NULL,                -- 'UP' / 'DOWN' / 'PASS'
  amount             INTEGER NOT NULL,             -- 베팅 점수 (PASS = 0)
  baseline_price     REAL NOT NULL,                -- 베팅 시점 기준가
  bet_at             INTEGER NOT NULL,             -- unix sec
  settled            INTEGER NOT NULL DEFAULT 0,   -- 0/1
  outcome            TEXT,                         -- 'WIN' / 'LOSE' / 'VOID' / NULL
  actual_price       REAL,                         -- 정산 종가
  actual_change_pct  REAL,                         -- 변동률
  payout             INTEGER,                      -- 정산 후 점수 변화
  settled_at         INTEGER,
  FOREIGN KEY(user_id) REFERENCES users(id)
);

CREATE INDEX IF NOT EXISTS idx_bets_user_time   ON bets(user_id, bet_at DESC);
CREATE INDEX IF NOT EXISTS idx_bets_settle      ON bets(target_date, settled);
CREATE INDEX IF NOT EXISTS idx_bets_user_unsettled ON bets(user_id, settled);

-- ────────────────────────────────────────
-- daily_bet_count: 일일 한도 카운터
-- ────────────────────────────────────────
CREATE TABLE IF NOT EXISTS daily_bet_count (
  user_id TEXT NOT NULL,
  date    TEXT NOT NULL,                           -- YYYY-MM-DD (KST 기준)
  count   INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY(user_id, date),
  FOREIGN KEY(user_id) REFERENCES users(id)
);

-- ────────────────────────────────────────
-- closing_prices: 정산용 일별 종가 캐시
-- ────────────────────────────────────────
CREATE TABLE IF NOT EXISTS closing_prices (
  ticker     TEXT NOT NULL,
  date       TEXT NOT NULL,                        -- YYYY-MM-DD
  close      REAL NOT NULL,
  volume     INTEGER,
  fetched_at INTEGER NOT NULL,
  source     TEXT NOT NULL DEFAULT 'yahoo',        -- 'yahoo' / 'krx' / 'manual'
  PRIMARY KEY(ticker, date)
);

CREATE INDEX IF NOT EXISTS idx_closing_date ON closing_prices(date);

-- ────────────────────────────────────────
-- top30_universe: 분기별 TOP30 종목 풀
-- ────────────────────────────────────────
CREATE TABLE IF NOT EXISTS top30_universe (
  quarter         TEXT PRIMARY KEY,                -- '2026Q2'
  tickers_json    TEXT NOT NULL,                   -- JSON array [{code, name, sector, value}]
  effective_from  TEXT NOT NULL,                   -- YYYY-MM-DD
  effective_to    TEXT NOT NULL,
  created_at      INTEGER NOT NULL
);

-- ────────────────────────────────────────
-- ip_rate_limit: IP당 일일 사용자 생성 제한 (어뷰징 방어)
-- ────────────────────────────────────────
CREATE TABLE IF NOT EXISTS ip_rate_limit (
  ip_hash         TEXT NOT NULL,                   -- SHA256(ip) 앞 16자
  date            TEXT NOT NULL,
  user_creations  INTEGER NOT NULL DEFAULT 0,
  bet_submissions INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY(ip_hash, date)
);

-- ────────────────────────────────────────
-- audit_log: 운영 감사 로그
-- ────────────────────────────────────────
CREATE TABLE IF NOT EXISTS audit_log (
  id        INTEGER PRIMARY KEY AUTOINCREMENT,
  ts        INTEGER NOT NULL,
  event     TEXT NOT NULL,                         -- 'SETTLE_START' / 'SETTLE_DONE' / 'YF_FAIL' 등
  meta_json TEXT
);

CREATE INDEX IF NOT EXISTS idx_audit_ts ON audit_log(ts DESC);

-- ════════════════════════════════════════════════════════════
-- 시드 데이터: 2026Q2 TOP30 universe
-- (이후 분기마다 마이그레이션으로 갱신, 또는 운영 콘솔에서 직접 INSERT)
-- ════════════════════════════════════════════════════════════
INSERT OR REPLACE INTO top30_universe (quarter, tickers_json, effective_from, effective_to, created_at)
VALUES (
  '2026Q2',
  '[{"code":"005930","name":"삼성전자","sector":"IT","value":18747537},{"code":"000660","name":"SK하이닉스","sector":"IT","value":13430454},{"code":"005380","name":"현대차","sector":"경기관련소비재","value":1671810},{"code":"402340","name":"SK스퀘어","sector":"IT","value":1525020},{"code":"373220","name":"LG에너지솔루션","sector":"2차전지·신재생","value":1096875},{"code":"034020","name":"두산에너빌리티","sector":"산업재","value":815853},{"code":"028260","name":"삼성물산","sector":"산업재","value":740449},{"code":"329180","name":"HD현대중공업","sector":"산업재","value":715835},{"code":"012450","name":"한화에어로스페이스","sector":"산업재","value":684783},{"code":"000270","name":"기아","sector":"경기관련소비재","value":677427},{"code":"009150","name":"삼성전기","sector":"IT","value":676903},{"code":"207940","name":"삼성바이오로직스","sector":"헬스케어","value":675847},{"code":"105560","name":"KB금융","sector":"금융","value":570337},{"code":"032830","name":"삼성생명","sector":"금융","value":538724},{"code":"006400","name":"삼성SDI","sector":"IT","value":535903},{"code":"012330","name":"현대모비스","sector":"경기관련소비재","value":491385},{"code":"267260","name":"HD현대일렉트릭","sector":"산업재","value":489320},{"code":"055550","name":"신한지주","sector":"금융","value":467059},{"code":"006800","name":"미래에셋증권","sector":"금융","value":466016},{"code":"068270","name":"셀트리온","sector":"헬스케어","value":420078},{"code":"298040","name":"효성중공업","sector":"산업재","value":401149},{"code":"042660","name":"한화오션","sector":"산업재","value":399796},{"code":"086790","name":"하나금융지주","sector":"금융","value":375000},{"code":"035420","name":"NAVER","sector":"커뮤니케이션서비스","value":370000},{"code":"005490","name":"POSCO홀딩스","sector":"소재","value":340000},{"code":"000810","name":"삼성화재","sector":"금융","value":320000},{"code":"066570","name":"LG전자","sector":"경기관련소비재","value":300000},{"code":"010130","name":"고려아연","sector":"소재","value":295000},{"code":"017670","name":"SK텔레콤","sector":"커뮤니케이션서비스","value":280000},{"code":"051910","name":"LG화학","sector":"소재","value":275000}]',
  '2026-04-01',
  '2026-06-30',
  unixepoch()
);
