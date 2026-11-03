"""Reading: groups, messages, files, transcripts. Needs only the read key."""
from .. import client, ui
from ..client import enc, qs
from ..config import DOWNLOADS
from . import common


def list_groups(ctx):
    ui.explain("GET /api/groups lists every group the linked number(s) are in, with member and message counts.\n"
               "With several numbers a group that two of them are in is listed once; the ids of the numbers that are in\n"
               "it are shown. Pick one number in the Numbers menu to see only its groups.")
    s = ui.ask("Search by name (blank = all)")
    res = client.get(ctx, "/api/groups" + qs(search=s), show=False)
    if not res.ok:
        client.get(ctx, "/api/groups" + qs(search=s))
        return
    for g in res.get("groups", default=[]):
        ui.info(f"{g['subject'] or '(no name)'}  |  {g['participant_count']} members  |  {g['message_count']} messages")
        held = g.get("numbers") or []
        ui.info(f"     id: {g['jid']}" + (f"   (number{'s' if len(held) > 1 else ''} {', '.join(str(x) for x in held)})" if held else ""))
    ui.good(f"{res.get('count')} groups")


def show_messages(ctx):
    ui.explain("GET /api/messages (all groups) or /api/groups/:jid/messages (one group). Newest first.\n"
               "Filters: limit, type (text,image,audio,document...), sender (phone), search (text).")
    scope = ui.ask("(a)ll groups or (o)ne group", default="a")
    jid = common.pick_group(ctx) if scope.lower().startswith("o") else None
    if scope.lower().startswith("o") and not jid:
        return
    limit = ui.ask("How many", default="10")
    typ = ui.ask("Only these types, comma separated (blank = all)")
    search = ui.ask("Text contains (blank = any)")
    sender = ui.ask("Sender phone number (blank = anyone)")
    path = (f"/api/groups/{enc(jid)}/messages" if jid else "/api/messages") + qs(limit=limit, type=typ, search=search, sender=ui.numbers(sender)[0] if sender else None)
    res = client.get(ctx, path, show=False)
    if not res.ok:
        client.get(ctx, path)
        return
    msgs = res.get("messages", default=[])
    print()
    for m in reversed(msgs):
        ui.info(common.one_line(m))
    if msgs:
        ctx.last_uid = msgs[0]["uid"]
        ctx.cursor = res.get("next_after_uid")
    ui.good(f"{len(msgs)} messages. Use 'Show one message in full' to see everything about one.")


def one_message(ctx):
    ui.explain("GET /api/messages/:uid returns everything about one message, including reactions and the media link.")
    uid = common.pick_uid(ctx)
    if uid:
        client.get(ctx, f"/api/messages/{uid}")


def new_messages(ctx):
    ui.explain("Cursor pattern for your own integration: remember the highest uid you have seen, then ask for\n"
               "everything newer with ?after_uid=<uid>. Results come oldest first and include next_after_uid.")
    if ctx.cursor is None:
        r = client.get(ctx, "/api/messages?limit=1", show=False)
        ctx.cursor = r.get("next_after_uid") or 0
        ui.info(f"Starting point set to uid {ctx.cursor}. Send a message to a group, then run this again.")
        return
    res = client.get(ctx, f"/api/messages{qs(after_uid=ctx.cursor, limit=100)}")
    if res.ok and res.get("next_after_uid"):
        ctx.cursor = res.get("next_after_uid")
        ui.info(f"Cursor moved to {ctx.cursor}.")


def download_media(ctx):
    ui.explain("GET /api/media/:uid fetches the file from WhatsApp when you ask. WhatsApp deletes old files,\n"
               "so after a while this returns 410. Anything you need to keep must be saved soon after it arrives.")
    uid = common.pick_uid(ctx)
    if not uid:
        return
    meta = client.get(ctx, f"/api/messages/{uid}", show=False)
    media = meta.get("media") if meta.ok else None
    if not media:
        ui.warn("That message has no file.")
        return
    name = media.get("filename") or f"message_{uid}"
    if "." not in name:
        ext = {"image": ".jpg", "video": ".mp4", "audio": ".ogg", "sticker": ".webp"}.get(meta.get("type"), "")
        name += ext
    dest = DOWNLOADS / name
    status, size, ctype = client.download(ctx, f"/api/media/{uid}", dest)
    if status == 200:
        ui.good(f"Saved {size} bytes ({ctype}) to {dest}")
    else:
        ui.bad(f"HTTP {status}: {size}")
        ui.warn(client.HINTS.get(status, ""))


def put_transcript(ctx):
    ui.explain("PUT /api/messages/:uid/transcript lets your speech-to-text worker attach text to a voice note.")
    uid = common.pick_uid(ctx)
    if uid:
        text = ui.ask("Transcript text", required=True)
        client.put(ctx, f"/api/messages/{uid}/transcript", {"transcript": text}, admin=False)


def menu(ctx):
    ui.menu("Read groups and messages (read key)", [
        ("List groups", lambda: list_groups(ctx)),
        ("Show recent messages (with filters)", lambda: show_messages(ctx)),
        ("Show one message in full", lambda: one_message(ctx)),
        ("Check for new messages since last time (cursor)", lambda: new_messages(ctx)),
        ("Download a photo / document / voice note", lambda: download_media(ctx)),
        ("Attach a transcript to a voice note", lambda: put_transcript(ctx)),
    ])
