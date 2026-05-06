"""pytest 설정. ingest/ 모듈을 import 가능하게 sys.path 조정."""
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "ingest"))
