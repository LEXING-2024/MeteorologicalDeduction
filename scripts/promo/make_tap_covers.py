"""Deprecated entry point for TapTap covers.

The covers and the 16:9 promo are now built by ``make_taptap_clean.py`` so
that they contain nothing but the game logo and the game title.  This file
stays only so older commands keep working.
"""
from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from make_taptap_clean import main  # noqa: E402

if __name__ == "__main__":
    main()
