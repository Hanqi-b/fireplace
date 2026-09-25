#!/usr/bin/env python3
"""Play one Fireplace game in a browser on this computer.

Run from the repository root with ``python3 examples/play_web.py``.  The
installed equivalent is ``python -m fireplace.web_gui`` or ``fireplace-web``.
"""

from __future__ import annotations

import os
import sys

if __package__ in (None, ""):
    sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "..")))

from fireplace.web_gui.__main__ import main


if __name__ == "__main__":
    raise SystemExit(main())
