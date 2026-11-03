"""Several WhatsApp numbers: see them, choose which one the console uses, and add / link / pause / unlink /
rename / delete them.

Reading the list and choosing a number need only the read key. Adding, linking and removing numbers is done through
the portal, so those menu items need the portal password (Settings)."""
import os
import re
import sys
import time
import webbrowser

from .. import client, ui
from ..client import STATE
from ..config import DOWNLOADS
from . import common

PORTAL_NOTE = ("Adding and linking numbers goes through the portal, so it needs the portal password\n"
               "(PORTAL_PASSWORD on the server). Enter it once in Settings; it is saved outside the repo.")


# ---- listing ---------------------------------------------------------------------------------------------------

def _describe(ctx, n):
    mark = "  <- in use" if ctx.number and str(ctx.number) in (str(n["id"]), str(n.get("phone"))) else ""
    return f"id {n['id']}: {n['label']}  {n.get('phone') or '(not linked yet)'}  [{STATE.get(n['state'], n['state'])}]{mark}"


def fetch(ctx):
    """The numbers from GET /api/numbers (read key), quietly. Returns a list, or None when the call failed."""
    res = client.get(ctx, "/api/numbers", show=False)
    if not res.ok:
        return None
    nums = res.get("numbers", default=[])
    common.set_multi(len(nums) > 1)
    return nums


def show(ctx):
    ui.header("Numbers", "GET /api/numbers (read key)")
    ui.explain("Each number is a separate WhatsApp login. Reads cover all of them by default. For sending, the server picks "
               "the number itself when only one can do it; otherwise add a number (id or phone) to the request.")
    nums = fetch(ctx)
    if nums is None:
        client.request(ctx, "GET", "/api/numbers")
        return []
    for n in nums:
        ui.info(_describe(ctx, n))
    if not nums:
        ui.info("No numbers yet. Use  Add a new number  in this menu.")
    ui.info(f"Using: {ctx.number or 'automatic (server chooses)'}")
    return nums


def pick(ctx, prompt="Number id", nums=None, only=None):
    """Let the user choose one number (by id or phone). `only` is an optional filter on the number dicts.
    Returns the number dict, or None."""
    nums = nums if nums is not None else fetch(ctx)
    if nums is None:
        client.request(ctx, "GET", "/api/numbers")
        return None
    if only:
        nums = [n for n in nums if only(n)]
    if not nums:
        ui.warn("There is no number to choose from here.")
        return None
    print()
    for n in nums:
        ui.info(_describe(ctx, n))
    default = str(nums[0]["id"]) if len(nums) == 1 else None
    c = re.sub(r"\D", "", ui.ask(f"{prompt} (id or phone)", default=default, required=True))
    for n in nums:
        if c and (str(n["id"]) == c or str(n.get("phone") or "") == c):
            return n
    ui.warn("No such number. Nothing changed.")
    return None


# ---- choosing the number the console uses ---------------------------------------------------------------------

def choose(ctx):
    nums = show(ctx)
    if not nums:
        return
    print()
    ui.info("Type a number id (e.g. 2) or its phone to use that number for sending and filtering, or leave blank for automatic.")
    c = re.sub(r"\D", "", ui.ask("Number id", default=""))
    if not c:
        ctx.number = None
        ui.good("Automatic: the server chooses, and asks you when it is unclear.")
        return
    hit = next((n for n in nums if str(n["id"]) == c or str(n.get("phone") or "") == c), None)
    if hit:
        ctx.number = str(hit["id"])
        ui.good(f"Using number {hit['id']} ({hit['label']}). Sends, group changes, reads and the audit log now use it.")
    else:
        ui.warn("No such id. Nothing changed.")


# ---- portal: add, link, pause, rename, unlink, delete ---------------------------------------------------------

def _portal_numbers(ctx):
    """Numbers as the portal sees them (adds qr / pairing_code / has_login). Returns (list, max) or None."""
    res = client.portal(ctx, "GET", "/portal/numbers", show=False)
    return (res.get("numbers", default=[]), res.get("max")) if res.ok else None


def _one(ctx, nid):
    got = _portal_numbers(ctx)
    return next((n for n in (got[0] if got else []) if n["id"] == nid), None)


def _write_qr_page(n):
    """Put the QR (a PNG data URL) in a small page that refreshes itself, so it stays valid while WhatsApp rotates it."""
    DOWNLOADS.mkdir(parents=True, exist_ok=True)
    path = DOWNLOADS / f"link_number_{n['id']}.html"
    html = ('<!doctype html><meta charset="utf-8"><meta http-equiv="refresh" content="3">'
            f'<title>Link number {n["id"]}</title>'
            '<body style="font-family:sans-serif;text-align:center;margin-top:40px">'
            f'<h2>Link "{n.get("label", "")}"</h2>'
            f'<img src="{n["qr"]}" width="320" height="320" alt="WhatsApp QR code">'
            '<p>WhatsApp on the phone &rarr; Settings &rarr; Linked devices &rarr; Link a device &rarr; scan.<br>'
            'This page refreshes by itself; the code changes about every 20 seconds.</p></body>')
    path.write_text(html, encoding="utf-8")
    return path


def _open_file(path):
    try:
        if sys.platform.startswith("win") and hasattr(os, "startfile"):
            os.startfile(str(path))  # noqa: S606  (opens in the default browser)
        else:
            webbrowser.open(path.as_uri())
        return True
    except Exception:
        return False


def _wait_linked(ctx, nid, timeout=240):
    """Poll the portal until the number is connected, showing the QR page / pairing code when they appear."""
    ui.info("Waiting for the link to complete (Ctrl+C stops waiting; the number keeps trying on the server).")
    last, shown_code, opened = None, None, False
    end = time.time() + timeout
    try:
        while time.time() < end:
            n = _one(ctx, nid)
            if not n:
                ui.bad("Lost sight of the number (is the server up?).")
                return False
            if n.get("pairing_code") and n["pairing_code"] != shown_code:
                shown_code = n["pairing_code"]
                ui.header(f"Pairing code:  {shown_code}")
                ui.info("On the phone that has this number:")
                ui.info("  WhatsApp -> Settings -> Linked devices -> Link a device")
                ui.info("  -> tap 'Link with phone number instead' -> type the code above.")
            if n.get("qr"):
                page = _write_qr_page(n)
                if not opened:
                    opened = True
                    print()
                    ui.info(f"QR code page: {page}")
                    if _open_file(page):
                        ui.info("Opened in your browser. Scan it: WhatsApp -> Settings -> Linked devices -> Link a device.")
                    else:
                        ui.info("Could not open it automatically; open that file in a browser, or scan from the portal.")
                    ui.info("You can also scan it from the portal: " + ctx.cfg.url + "/")
            state = n.get("state")
            if state != last:
                ui.info(f"state: {STATE.get(state, state)}")
                last = state
            if state == "open":
                ui.good(f"Linked and listening as {n.get('phone') or 'the number'}.")
                return True
            if state in ("logged_out", "replaced") and n.get("last_error"):
                ui.warn(n["last_error"])
                return False
            time.sleep(2)
    except KeyboardInterrupt:
        print()
        ui.info("Stopped waiting.")
        return False
    ui.warn("Still not linked. Run  Link or re-link a number  again, or finish in the portal: " + ctx.cfg.url + "/")
    return False


def _offer_use(ctx, nid):
    if ctx.number != str(nid) and ui.confirm(f"Use number {nid} for the rest of this session?", default=False):
        ctx.number = str(nid)
        ui.good(f"Using number {nid}.")


def link(ctx, nid=None):
    """Start the link for a number: QR code or pairing code (or just resume it if the login is still saved)."""
    ui.explain("POST /portal/numbers/:id/connect  {phone?}\n"
               "QR code: scan it from the phone.  Pairing code: give the phone number and type the 8-character code\n"
               "into WhatsApp (easier when the phone is not next to the screen).\n" + PORTAL_NOTE)
    got = _portal_numbers(ctx)
    if got is None:
        client.portal(ctx, "GET", "/portal/numbers")
        return
    nums = got[0]
    n = next((x for x in nums if x["id"] == nid), None) if nid else pick(ctx, "Which number to link", nums, only=lambda x: x["state"] != "open")
    if not n:
        return
    nid = n["id"]
    phone = None
    if n.get("has_login") and n["state"] in ("idle", "logged_out"):
        ui.info("This number still has a saved login, so it only needs to be started (no new scan).")
    else:
        how = ui.ask("Link with (q)r code or (p)airing code", default="q").lower()
        if how.startswith("p"):
            digits = ui.numbers(ui.ask("Phone number of this WhatsApp, with country code, digits only (e.g. 919311855419)", required=True))
            phone = digits[0] if digits else None
            if not phone or not 8 <= len(phone) <= 15:
                ui.bad("That does not look like a full phone number with country code.")
                return
    res = client.portal(ctx, "POST", f"/portal/numbers/{nid}/connect", {"phone": phone} if phone else {})
    if res.ok and _wait_linked(ctx, nid):
        _offer_use(ctx, nid)


def add(ctx):
    ui.explain("POST /portal/numbers  {label}. Creates an empty slot with a name; then it is linked to a phone.\n" + PORTAL_NOTE)
    label = ui.ask("A name for this number (e.g. CX Mumbai)", required=True)
    res = client.portal(ctx, "POST", "/portal/numbers", {"label": label})
    if not res.ok:
        return
    nid = res.get("id")
    ui.good(f"Added number {nid}: {label}")
    if nid and ui.confirm("Link it to a phone now?", default=True):
        link(ctx, nid)


def pause(ctx):
    ui.explain("POST /portal/numbers/:id/disconnect stops listening on this number but keeps its login, so it can be\n"
               "started again without scanning. Messages sent while it is paused are not recorded.")
    n = pick(ctx, "Which number to pause", only=lambda x: x["state"] != "idle")
    if n and ui.confirm(f"Pause '{n['label']}'?", default=True):
        client.portal(ctx, "POST", f"/portal/numbers/{n['id']}/disconnect", {})


def unlink(ctx):
    ui.explain("POST /portal/numbers/:id/unlink logs the number out of WhatsApp and deletes its saved login.\n"
               "To listen again it has to be linked from scratch (new QR or pairing code).")
    n = pick(ctx, "Which number to unlink")
    if n and ui.confirm(f"Unlink '{n['label']}' ({n.get('phone') or 'no phone'})? You will need to scan again.", default=False):
        client.portal(ctx, "POST", f"/portal/numbers/{n['id']}/unlink", {})
        if ctx.number == str(n["id"]):
            ctx.number = None


def rename(ctx):
    ui.explain("PUT /portal/numbers/:id  {label}")
    n = pick(ctx, "Which number to rename")
    if n:
        client.portal(ctx, "PUT", f"/portal/numbers/{n['id']}", {"label": ui.ask("New name", default=n["label"], required=True)})


def delete(ctx):
    ui.explain("DELETE /portal/numbers/:id removes an empty number slot.\n"
               "The server only allows it for a number that is unlinked and has no stored messages\n"
               "(otherwise it answers 409: unlink it first / it has stored messages).")
    n = pick(ctx, "Which number to delete")
    if n and ui.confirm(f"Delete '{n['label']}'?", default=False):
        res = client.portal(ctx, "DELETE", f"/portal/numbers/{n['id']}")
        if res.ok and ctx.number == str(n["id"]):
            ctx.number = None


def portal_view(ctx):
    ui.explain("GET /portal/numbers is the portal's view: like /api/numbers plus has_login, and the QR / pairing\n"
               "code while a number is being linked. (The public API never returns QR codes.)")
    got = _portal_numbers(ctx)
    if got is None:
        client.portal(ctx, "GET", "/portal/numbers")
        return
    nums, mx = got
    for n in nums:
        extra = " (login saved)" if n.get("has_login") else ""
        extra += f"  pairing code {n['pairing_code']}" if n.get("pairing_code") else ""
        extra += "  QR waiting" if n.get("qr") else ""
        ui.info(_describe(ctx, n) + extra)
    ui.info(f"{len(nums)} of {mx} numbers used")


def menu(ctx):
    ui.menu("Numbers", [
        ("List numbers and their status", lambda: show(ctx)),
        ("Choose which number the console uses (blank = automatic)", lambda: choose(ctx)),
        ("Add a new number and link it  (portal password)", lambda: add(ctx)),
        ("Link or re-link a number: QR code or pairing code  (portal password)", lambda: link(ctx)),
        ("Pause listening on a number  (portal password)", lambda: pause(ctx)),
        ("Unlink a number from WhatsApp  (portal password)", lambda: unlink(ctx)),
        ("Rename a number  (portal password)", lambda: rename(ctx)),
        ("Delete an unused number  (portal password)", lambda: delete(ctx)),
        ("Portal view: login saved, pairing code, slots used  (portal password)", lambda: portal_view(ctx)),
    ], sub="Listing and choosing use the read key; add / link / remove use the portal password.")
