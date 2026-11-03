"""Settings live in your home folder (never inside the repo), so keys cannot be committed by accident.
Environment variables WA_URL, WA_KEY, WA_ADMIN and WA_PORTAL override the saved values when set."""
import json
import os
import pathlib

PATH = pathlib.Path.home() / ".wa_api_tester.json"
DOWNLOADS = pathlib.Path.home() / "wa_api_downloads"
DEFAULTS = {"url": "http://15.207.167.135:3000", "api_key": "", "admin_key": "", "portal_password": "", "test_numbers": [], "show_curl": True}


class Config:
    def __init__(self):
        self.data = dict(DEFAULTS)
        try:
            self.data.update(json.loads(PATH.read_text(encoding="utf-8")))
        except (OSError, ValueError):
            pass

    @property
    def url(self):
        return (os.environ.get("WA_URL") or self.data["url"]).rstrip("/")

    @property
    def api_key(self):
        return os.environ.get("WA_KEY") or self.data["api_key"]

    @property
    def admin_key(self):
        return os.environ.get("WA_ADMIN") or self.data["admin_key"]

    @property
    def portal_password(self):
        return os.environ.get("WA_PORTAL") or self.data.get("portal_password", "")

    @property
    def test_numbers(self):
        return self.data.get("test_numbers") or []

    @property
    def show_curl(self):
        return bool(self.data.get("show_curl", True))

    def set(self, **kw):
        self.data.update(kw)
        self.save()

    def save(self):
        try:
            PATH.write_text(json.dumps(self.data, indent=2), encoding="utf-8")
        except OSError as e:
            print(f"(could not save settings to {PATH}: {e})")


def mask(key):
    if not key:
        return "(not set)"
    return key[:4] + "…" + key[-3:] if len(key) > 10 else "set"


class Context:
    """What the console remembers during a session, so you can reuse the last group / message."""

    def __init__(self):
        self.cfg = Config()
        self.last_group = None   # jid of the group last created / picked
        self.last_uid = None     # uid of the last message sent or looked at
        self.cursor = None       # for "new messages since last check"
        self.number = None       # which WhatsApp number to use (id or phone); None = let the server choose
        self.portal = None       # cookie-aware opener for the portal login (used to add / link numbers)
        self.portal_ok = False   # True once the portal login succeeded
