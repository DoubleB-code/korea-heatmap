#!/usr/bin/env bash
# 로컬 실행 헬퍼: 데이터 수집 + 정적 서버 기동
set -euo pipefail
cd "$(dirname "$0")/.."

# 1) 가상환경 (없으면 생성)
if [ ! -d ".venv" ]; then
  python3 -m venv .venv
  ./.venv/bin/pip install --upgrade pip
  ./.venv/bin/pip install -r requirements.txt
fi

# 2) 데이터 수집
./.venv/bin/python ingest/run.py "$@"

# 3) 정적 서버 (포트 8080)
echo ""
echo "============================================"
echo "  ✓ 데이터 갱신 완료"
echo "  → http://localhost:8080 에서 확인"
echo "  (Ctrl+C 로 종료)"
echo "============================================"
echo ""
cd web
python3 -m http.server 8080
