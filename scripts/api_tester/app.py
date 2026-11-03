"""Main menu."""
from . import ui
from .config import Context
from .flows import groups, guided, live, numbers, profile, read, send, setup

BANNER = r"""
  HEXALOG  WhatsApp Listener API: developer test console
  Explore every endpoint with prompts instead of writing requests by hand.
"""


def first_run_help(ctx):
    if ctx.cfg.api_key and ctx.cfg.admin_key:
        return
    ui.header("First time here", "Two things are needed before anything works")
    ui.info("1. Server URL and the two keys: choose  Settings  from the main menu.")
    ui.info("     Read key  = API_KEY on the server (reading only)")
    ui.info("     Admin key = ADMIN_API_KEY on the server (sending and group changes)")
    ui.info("   Ask the person who runs the server. They live in the server's .env file.")
    ui.info("2. The WhatsApp number must be linked: choose  Numbers  (add / link by QR or pairing code), or open the portal")
    ui.info("   at the server URL. Adding and linking numbers also needs the portal password (Settings).")
    ui.info("Then run  Connection check  and the  Guided walkthrough.")


def main():
    ctx = Context()
    print(BANNER)
    try:
        first_run_help(ctx)
        ui.menu("Main menu", [
            ("Guided walkthrough (start here: runs everything, explains each step)", lambda: guided.run(ctx)),
            ("Connection check (server, number linked, keys)", lambda: setup.check_everything(ctx)),
            ("Numbers: list, choose, add, link (QR / pairing code), remove", lambda: numbers.menu(ctx)),
            ("Read groups and messages, download files", lambda: read.menu(ctx)),
            ("Send messages, polls, files, reactions", lambda: send.menu(ctx)),
            ("Manage groups (create, add, admin, settings, invite)", lambda: groups.menu(ctx)),
            ("Profile of the linked number, audit log", lambda: profile.menu(ctx)),
            ("Live events and webhooks", lambda: live.menu(ctx)),
            ("Settings (server URL, keys, portal password, test numbers)", lambda: setup.settings(ctx)),
        ], sub=f"Server: {ctx.cfg.url}  (change it in Settings)", back="Quit")
    except ui.Quit:
        pass
    print("\n  Bye.")
