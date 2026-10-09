-- ════════════════════════════════════════════════════════════
-- D + E + F 준비:
--   D) 카카오 OAuth: users 테이블 확장 + oauth_state 임시 테이블
--   E) 명예의 전당 (HoF): is_pro 플래그 + 자격 메타
--   F) 베팅 열람 시장: bet_reveals 테이블 + privacy 플래그
-- ════════════════════════════════════════════════════════════
-- 적용:
--   wrangler d1 execute kospi-bets --remote --file=migrations/0002_oauth_hof_reveals.sql
-- ════════════════════════════════════════════════════════════

-- ──────────────────────────────────────
-- D) OAuth 컬럼 추가 (users)
-- ──────────────────────────────────────
ALTER TABLE users ADD COLUMN auth_provider TEXT NOT NULL DEFAULT 'anon';
  -- 'anon' / 'kakao' / 'google' (D3는 kakao 만)

ALTER TABLE users ADD COLUMN auth_external_id TEXT;
  -- 카카오의 user.id (정수형이지만 TEXT로 저장)

ALTER TABLE users ADD COLUMN display_name TEXT;
  -- 카카오 닉네임 (변경 가능, 운영자는 nickname 만 사용)

ALTER TABLE users ADD COLUMN avatar_url TEXT;
  -- 카카오 프로필 이미지 (선택)

-- 카카오 + external_id 유니크 (한 카카오 계정 = 한 user)
CREATE UNIQUE INDEX IF NOT EXISTS idx_users_external
  ON users(auth_provider, auth_external_id)
  WHERE auth_external_id IS NOT NULL;

-- ──────────────────────────────────────
-- E) 명예의 전당
-- ──────────────────────────────────────
ALTER TABLE users ADD COLUMN is_pro INTEGER NOT NULL DEFAULT 0;
  -- 1 = HoF 입성 (정산 30회 + 적중률 60% + 30일 활동)

ALTER TABLE users ADD COLUMN pro_qualified_at INTEGER;
  -- 최초 HoF 통과 unix sec (강등돼도 이력 보존)

CREATE INDEX IF NOT EXISTS idx_users_pro
  ON users(is_pro DESC, points DESC) WHERE banned = 0;

-- ──────────────────────────────────────
-- F) Privacy + 베팅 열람 시장
-- ──────────────────────────────────────
ALTER TABLE users ADD COLUMN bets_public INTEGER NOT NULL DEFAULT 1;
  -- 1 = HoF 입성 시 베팅 공개 (기본값)
  -- 0 = 사용자가 OFF — 공개 안 됨 (HoF 진입 가능하지만 베팅 비공개)

-- 베팅 열람 결제 기록
CREATE TABLE IF NOT EXISTS bet_reveals (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  viewer_user_id  TEXT NOT NULL,
  target_user_id  TEXT NOT NULL,
  target_date     TEXT NOT NULL,             -- 어느 영업일의 베팅을 열람
  cost            INTEGER NOT NULL,           -- 지불한 점수
  refund          INTEGER NOT NULL DEFAULT 0, -- target에게 환원된 점수 (cost의 50%)
  revealed_at     INTEGER NOT NULL,
  -- 같은 사용자 같은 날짜는 한 번만 결제
  UNIQUE(viewer_user_id, target_user_id, target_date),
  FOREIGN KEY(viewer_user_id) REFERENCES users(id),
  FOREIGN KEY(target_user_id) REFERENCES users(id)
);

CREATE INDEX IF NOT EXISTS idx_reveals_target
  ON bet_reveals(target_user_id, target_date);
CREATE INDEX IF NOT EXISTS idx_reveals_viewer
  ON bet_reveals(viewer_user_id, revealed_at DESC);

-- ──────────────────────────────────────
-- OAuth state nonce (CSRF 방지, 짧은 TTL)
-- ──────────────────────────────────────
CREATE TABLE IF NOT EXISTS oauth_state (
  state       TEXT PRIMARY KEY,        -- random nonce
  current_uid TEXT,                    -- 현재 익명 user_id (있으면 마이그레이션)
  created_at  INTEGER NOT NULL,
  -- 10분 TTL은 코드에서 검증
  return_url  TEXT
);

CREATE INDEX IF NOT EXISTS idx_oauth_state_created ON oauth_state(created_at);

-- ──────────────────────────────────────
-- 사용자 점수 변동 로그 (감사용, 분쟁 대응)
-- ──────────────────────────────────────
CREATE TABLE IF NOT EXISTS points_ledger (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id    TEXT NOT NULL,
  delta      INTEGER NOT NULL,         -- + 증가 / - 차감
  reason     TEXT NOT NULL,
    -- 'BET_PLACED' / 'BET_SETTLED_WIN' / 'BET_SETTLED_VOID'
    -- 'REVEAL_PAID' / 'REVEAL_EARNED' (HoF 50% 환원)
    -- 'SIGNUP_BONUS' / 'ADMIN_ADJUST'
  ref_id     TEXT,                     -- bet.id 또는 reveal.id 등
  balance_after INTEGER NOT NULL,
  ts         INTEGER NOT NULL,
  FOREIGN KEY(user_id) REFERENCES users(id)
);

CREATE INDEX IF NOT EXISTS idx_ledger_user_ts ON points_ledger(user_id, ts DESC);
