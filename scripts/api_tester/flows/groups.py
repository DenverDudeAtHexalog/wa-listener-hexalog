"""Group management. Needs the admin key, and the linked number must be an admin of the group
(always true for groups it creates itself)."""
import base64
import pathlib

from .. import client, ui
from ..client import enc
from . import common

NOTE = "Group actions are paced (5 to 10 s apart) and limited: 10 new groups/day, 100 member changes/day."


def create(ctx):
    ui.explain("POST /api/groups  {subject, participants}. The linked number becomes the group's admin.\n" + NOTE)
    name = ui.ask("Group name", required=True)
    nums = common.test_numbers(ctx)
    res = client.post(ctx, "/api/groups", {"subject": name, "participants": nums})
    if res.ok and res.get("jid"):
        ctx.last_group = res.get("jid")
        ui.good(f"Group created. Remembered it as 'last group': {ctx.last_group}")


def members(ctx, action, verb):
    ui.explain(f"POST /api/groups/:jid/participants  {{action:'{action}', participants:[...]}}\n"
               "Result is per person. For 'add', people whose privacy blocks being added can be sent the\n"
               "invite link instead (invite_fallback).\n" + NOTE)
    jid = common.pick_group(ctx)
    if not jid:
        return
    nums = common.test_numbers(ctx, f"Numbers to {verb} (comma separated)")
    body = {"action": action, "participants": nums}
    if action == "add" and ui.confirm("If someone cannot be added, DM them the invite link?", default=True):
        body["invite_fallback"] = True
    if action == "remove" and not ui.confirm(f"Remove {', '.join(nums)} from the group?"):
        return
    client.post(ctx, f"/api/groups/{enc(jid)}/participants", body)


def rename(ctx):
    ui.explain("PUT /api/groups/:jid/subject  {subject}")
    jid = common.pick_group(ctx)
    if jid:
        client.put(ctx, f"/api/groups/{enc(jid)}/subject", {"subject": ui.ask("New name", required=True)})


def description(ctx):
    ui.explain("PUT /api/groups/:jid/description  {description}")
    jid = common.pick_group(ctx)
    if jid:
        client.put(ctx, f"/api/groups/{enc(jid)}/description", {"description": ui.ask("New description", required=True)})


def settings(ctx):
    ui.explain("PUT /api/groups/:jid/settings  {announce?, locked?, member_add_mode?, join_approval?, ephemeral_seconds?}\n"
               "announce: only admins can send.  locked: only admins can edit group info.\n"
               "member_add_mode: 'admin' or 'all'.  join_approval: admins approve new joiners.\n"
               "ephemeral_seconds: disappearing messages (0 off, 86400 = 24h, 604800 = 7d, 7776000 = 90d).")
    jid = common.pick_group(ctx)
    if not jid:
        return
    body = {}
    for key, q in (("announce", "Only admins can send messages"), ("locked", "Only admins can edit group info"),
                   ("join_approval", "Admins must approve new members")):
        v = ui.ask(f"{q}? (y/n/skip)", default="skip").lower()
        if v.startswith("y") or v.startswith("n"):
            body[key] = v.startswith("y")
    m = ui.ask("Who can add members? (admin/all/skip)", default="skip").lower()
    if m in ("admin", "all"):
        body["member_add_mode"] = m
    e = ui.ask("Disappearing messages seconds (0 = off, blank = skip)")
    if e.isdigit():
        body["ephemeral_seconds"] = int(e)
    if not body:
        ui.warn("Nothing selected.")
        return
    client.put(ctx, f"/api/groups/{enc(jid)}/settings", body)


def picture(ctx):
    ui.explain("PUT /api/groups/:jid/picture  {data_base64}  (a JPEG or PNG).  DELETE removes it.")
    jid = common.pick_group(ctx)
    if not jid:
        return
    if ui.ask("(s)et or (r)emove", default="s").lower().startswith("r"):
        client.delete(ctx, f"/api/groups/{enc(jid)}/picture")
        return
    p = pathlib.Path(ui.ask("Path of the image file", required=True).strip('"'))
    if p.is_file():
        client.put(ctx, f"/api/groups/{enc(jid)}/picture", {"data_base64": base64.b64encode(p.read_bytes()).decode()})
    else:
        ui.bad("File not found.")


def invite(ctx):
    ui.explain("GET /api/groups/:jid/invite returns the invite link.\n"
               "POST /api/groups/:jid/invite/revoke resets it (the old link stops working).")
    jid = common.pick_group(ctx)
    if not jid:
        return
    if ui.ask("(g)et link or (r)evoke and get a new one", default="g").lower().startswith("r"):
        if ui.confirm("The old link will stop working. Continue?"):
            client.post(ctx, f"/api/groups/{enc(jid)}/invite/revoke")
    else:
        client.get(ctx, f"/api/groups/{enc(jid)}/invite", admin=True)


def join(ctx):
    ui.explain("POST /api/groups/join  {invite}. Accepts a full chat.whatsapp.com link or just the code.")
    code = ui.ask("Invite link or code", required=True)
    res = client.post(ctx, "/api/groups/join", {"invite": code})
    if res.ok and res.get("jid"):
        ctx.last_group = res.get("jid")


def leave(ctx):
    ui.explain("POST /api/groups/:jid/leave. The linked number leaves the group and stops recording it.")
    jid = common.pick_group(ctx)
    if jid and ui.confirm(f"Really leave {jid}?"):
        client.post(ctx, f"/api/groups/{enc(jid)}/leave")


def refresh(ctx):
    ui.explain("POST /api/groups/:jid/refresh re-reads members and settings from WhatsApp.")
    jid = common.pick_group(ctx)
    if jid:
        client.post(ctx, f"/api/groups/{enc(jid)}/refresh")


def join_requests(ctx):
    ui.explain("GET /api/groups/:jid/join-requests lists people waiting for approval.\n"
               "POST the same path with {action:'approve'|'reject', participants:[...]} to decide.")
    jid = common.pick_group(ctx)
    if not jid:
        return
    res = client.get(ctx, f"/api/groups/{enc(jid)}/join-requests", admin=True)
    if res.ok and ui.confirm("Approve or reject some of them now?"):
        act = ui.ask("approve or reject", default="approve")
        nums = ui.numbers(ui.ask("Phone numbers", required=True))
        client.post(ctx, f"/api/groups/{enc(jid)}/join-requests", {"action": act, "participants": nums})


def menu(ctx):
    ui.menu("Manage groups (admin key)", [
        ("Create a group", lambda: create(ctx)),
        ("Add people", lambda: members(ctx, "add", "add")),
        ("Make people admin (promote)", lambda: members(ctx, "promote", "promote")),
        ("Remove admin rights (demote)", lambda: members(ctx, "demote", "demote")),
        ("Remove people", lambda: members(ctx, "remove", "remove")),
        ("Rename a group", lambda: rename(ctx)),
        ("Set a group description", lambda: description(ctx)),
        ("Group settings (admin-only chat, who can add, disappearing messages)", lambda: settings(ctx)),
        ("Group picture", lambda: picture(ctx)),
        ("Invite link (get / reset)", lambda: invite(ctx)),
        ("Join a group from an invite link", lambda: join(ctx)),
        ("Join requests (approve / reject)", lambda: join_requests(ctx)),
        ("Re-read group info from WhatsApp", lambda: refresh(ctx)),
        ("Leave a group", lambda: leave(ctx)),
    ], sub=NOTE)
