-- 일별 방문자 카운터
CREATE TABLE IF NOT EXISTS daily_visits (
  date TEXT NOT NULL,
  visitor_id TEXT NOT NULL,
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  PRIMARY KEY (date, visitor_id)
);

CREATE INDEX IF NOT EXISTS idx_daily_visits_date ON daily_visits(date);
