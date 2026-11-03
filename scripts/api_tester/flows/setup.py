"""Settings and the connection check: the first thing to run."""
from .. import client, ui
from ..config import PATH, mask


def check_everything(ctx, quiet=False):
    """Returns True when the server is reachable, the number is linked and the read key works."""
    cfg = ctx.cfg
    ui.header("Connection check", f"Server: {cfg.url}")
    ui.explain("GET /api/status needs the read key. It says whether WhatsApp is linked.")
    st = client.get(ctx, "/api/status")
    if st.status == 0:
        return False
    if not st.ok:
        return False
    state = st.get("state")
    nums = st.get("numbers")
    if nums and nums.get("total", 0) > 1:
        ui.info(f"{nums.get('open')} of {nums.get('total')} numbers connected. Use  Numbers  in the main menu to see them or pick one.")
    if state == "open":
        ui.good(f"WhatsApp is connected as {st.get('me', 'jid', default='?')}")
    else:
        ui.warn(f"WhatsApp state is '{state}'. Open the portal at {cfg.url}/ and link the number (QR code).")

    ui.explain("GET /api/actions needs the admin key. If it works, writing is enabled on the server.")
    ad = client.get(ctx, "/api/actions?limit=1", admin=True, show=False)
    if ad.ok:
        ui.good("Admin key works: sending and group management are enabled.")
    elif ad.status == 0:
        ui.bad("Admin key not set in Settings.")
    else:
        ui.bad(f"Admin key check failed (HTTP {ad.status}). {client.HINTS.get(ad.status, '')}")
        if ad.status == 403 or ad.status == 401:
            ui.info("On the server: set ADMIN_API_KEY in .env (different from API_KEY), then `docker compose up -d --force-recreate app`.")
    g = client.get(ctx, "/api/groups", show=False)
    if g.ok:
        ui.good(f"{g.get('count')} groups visible to this number.")
    return state == "open"


def settings(ctx):
    cfg = ctx.cfg
    while True:
        ui.header("Settings", f"Saved in {PATH} (outside the repo)")
        ui.info(f"1) Server URL     : {cfg.url}")
        ui.info(f"2) Read key       : {mask(cfg.api_key)}   (API_KEY on the server)")
        ui.info(f"3) Admin key      : {mask(cfg.admin_key)}   (ADMIN_API_KEY on the server)")
        ui.info(f"4) Test numbers   : {', '.join(cfg.test_numbers) or '(none)'}")
        ui.info(f"5) Show curl lines: {'yes' if cfg.show_curl else 'no'}")
        ui.info("0) Back")
        c = ui.ask("Change which")
        if c in ("0", ""):
            return
        if c == "1":
            cfg.set(url=ui.ask("Server URL, e.g. http://15.207.167.135:3000", default=cfg.url).rstrip("/"))
        elif c == "2":
            cfg.set(api_key=ui.ask("Read key (API_KEY)", required=True))
        elif c == "3":
            cfg.set(admin_key=ui.ask("Admin key (ADMIN_API_KEY)", required=True))
        elif c == "4":
            cfg.set(test_numbers=ui.numbers(ui.ask("Numbers you own / may message while testing", required=True)))
        elif c == "5":
            cfg.set(show_curl=not cfg.show_curl)
        if c in ("1", "2", "3", "4", "5"):
            ui.good("Saved.")
