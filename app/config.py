import os
import sys
from pathlib import Path

if getattr(sys, "frozen", False):
    APP_DIR = Path(sys.executable).resolve().parent
    BUNDLE_DIR = Path(getattr(sys, "_MEIPASS", APP_DIR))
else:
    APP_DIR = Path(__file__).resolve().parent.parent
    BUNDLE_DIR = APP_DIR

DATA_DIR = Path(os.getenv("GATEWAY_DATA_DIR", APP_DIR / "data"))
DATA_DIR.mkdir(exist_ok=True)

DB_PATH = str(DATA_DIR / "gateway.db")
STATIC_DIR = BUNDLE_DIR / "static"

DEFAULT_PROVIDER_TIMEOUT = 120
