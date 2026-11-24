"""Deprecated alias for the TapTap artwork builder.

Use ``make_taptap_rich.py``.  This module stays so older commands such as
``make_tap_covers.py`` keep working.
"""
from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from make_taptap_rich import main  # noqa: E402

if __name__ == "__main__":
    main()
