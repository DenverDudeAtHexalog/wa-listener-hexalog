#!/usr/bin/env python3
"""Developer test console for the WhatsApp Listener API. Python 3.8+, no packages to install.

Run it:        python try_api.py
In PyCharm:    right-click this file -> Run 'try_api'. The menu appears in the Run window; type the
               number of a menu item into the window and press Enter.

First time: choose "Settings" and enter the server URL, the read key and the admin key.
They are saved in your home folder (~/.wa_api_tester.json), never in the repo.
(WA_URL, WA_KEY and WA_ADMIN environment variables also work and take priority.)
"""
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from api_tester.app import main  # noqa: E402

if __name__ == "__main__":
    main()
