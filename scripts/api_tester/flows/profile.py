"""The linked number's own WhatsApp profile, and the audit log of everything done through the API."""
import base64
import pathlib

from .. import client, ui


def name(ctx):
    ui.explain("PUT /api/profile/name  {name}")
    client.put(ctx, "/api/profile/name", {"name": ui.ask("New display name", required=True)})


def status(ctx):
    ui.explain("PUT /api/profile/status  {status}  (the 'About' text)")
    client.put(ctx, "/api/profile/status", {"status": ui.ask("New About text", required=True)})


def picture(ctx):
    ui.explain("PUT /api/profile/picture  {data_base64}   DELETE /api/profile/picture removes it")
    if ui.ask("(s)et or (r)emove", default="s").lower().startswith("r"):
        client.delete(ctx, "/api/profile/picture")
        return
    p = pathlib.Path(ui.ask("Path of the image file", required=True).strip('"'))
    if p.is_file():
        client.put(ctx, "/api/profile/picture", {"data_base64": base64.b64encode(p.read_bytes()).decode()})
    else:
        ui.bad("File not found.")


def audit(ctx):
    ui.explain("GET /api/actions is the audit log: every send, group change and profile change made through\nthe API, with its result and the number it ran on (n1, n2...). Choose a number in the\nNumbers menu to see only that one.")
    res = client.get(ctx, f"/api/actions?limit={ui.ask('How many entries', default='15')}", admin=True, show=False)
    if not res.ok:
        client.get(ctx, "/api/actions?limit=1", admin=True)
        return
    for a in res.get("actions", default=[]):
        ui.info(f"{str(a.get('ts'))[:19]}  n{a.get('number_id', '?'):<2} {a.get('action', ''):<16} {str(a.get('target') or '')[:32]:<32} {'ok' if a.get('ok') else 'FAILED: ' + str(a.get('error'))}")


def menu(ctx):
    ui.menu("Profile and audit log (admin key)", [
        ("Change display name", lambda: name(ctx)),
        ("Change About text", lambda: status(ctx)),
        ("Profile picture", lambda: picture(ctx)),
        ("Audit log of API actions", lambda: audit(ctx)),
    ])
