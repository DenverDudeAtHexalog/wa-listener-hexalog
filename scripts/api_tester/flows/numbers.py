"""Several WhatsApp numbers: see them and choose which one the console uses."""
from .. import client, ui

STATE = {"open": "connected", "idle": "not connected", "qr": "waiting for QR scan", "connecting": "connecting",
         "reconnecting": "reconnecting", "logged_out": "unlinked", "replaced": "used elsewhere", "pairing": "waiting for pairing code"}


def show(ctx):
    ui.header("Numbers", "GET /api/numbers (read key)")
    ui.explain("Each number is a separate WhatsApp login. Reads cover all of them by default. For sending, the server picks "
               "the number itself when only one can do it; otherwise add a number (id or phone) to the request.")
    res = client.get(ctx, "/api/numbers", show=False)
    if not res.ok:
        client.request(ctx, "GET", "/api/numbers")
        return []
    nums = res.get("numbers", default=[])
    for n in nums:
        mark = "  <- in use" if ctx.number and str(ctx.number) in (str(n["id"]), str(n.get("phone"))) else ""
        ui.info(f"id {n['id']}: {n['label']}  {n.get('phone') or '(not linked yet)'}  [{STATE.get(n['state'], n['state'])}]{mark}")
    ui.info(f"Using: {ctx.number or 'automatic (server chooses)'}")
    return nums


def choose(ctx):
    nums = show(ctx)
    if not nums:
        return
    print()
    ui.info("Type a number id (e.g. 2) to use that number for sending and filtering, or leave blank for automatic.")
    c = ui.ask("Number id", default="")
    if not c:
        ctx.number = None
        ui.good("Automatic: the server chooses, and asks you when it is unclear.")
    elif c.isdigit() and any(str(n["id"]) == c for n in nums):
        ctx.number = c
        ui.good(f"Using number {c}. Sends, group changes and filters now include it.")
    else:
        ui.warn("No such id. Nothing changed.")
