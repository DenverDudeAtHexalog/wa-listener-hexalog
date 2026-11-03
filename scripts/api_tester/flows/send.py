"""Sending and acting on messages. Needs the admin key."""
import base64
import mimetypes
import pathlib

from .. import client, ui
from . import common

WRITE_NOTE = ("Sending goes through a paced queue on the server (random 1.5 to 4 second gaps, 120 messages\n"
              "per hour). Only message people who expect it, and prefer your own test numbers.")


def _remember(ctx, res):
    if res.ok and res.get("uid"):
        ctx.last_uid = res.get("uid")
        ui.info(f"Remembered message uid {ctx.last_uid} for react / edit / delete.")


def send_text(ctx):
    ui.explain("POST /api/send/text  {to, text, mentions?, reply_to_uid?}\n" + WRITE_NOTE)
    to = common.pick_target(ctx)
    if not to:
        return
    text = ui.ask("Message text", required=True)
    body = {"to": to, "text": text}
    m = ui.ask("Tag people? phone numbers (blank = none). Put @number in the text too")
    if m:
        body["mentions"] = ui.numbers(m)
    r = ui.ask("Reply to a message? its uid (blank = no)")
    if r.isdigit():
        body["reply_to_uid"] = int(r)
    _remember(ctx, client.post(ctx, "/api/send/text", body))


def send_media(ctx):
    ui.explain("POST /api/send/media  {to, type, data_base64, caption?, filename?, mimetype?, voice_note?}\n"
               "type = image, video, audio, document or sticker. The file is sent as base64 in the JSON body.\n"
               "A voice note is type audio + voice_note true with an .ogg (opus) file.")
    to = common.pick_target(ctx)
    if not to:
        return
    path = pathlib.Path(ui.ask("Full path of the file on this computer", required=True).strip('"'))
    if not path.is_file():
        ui.bad("File not found.")
        return
    mime = mimetypes.guess_type(path.name)[0] or "application/octet-stream"
    guess = ("image" if mime.startswith("image/") and mime != "image/webp" else "video" if mime.startswith("video/")
             else "audio" if mime.startswith("audio/") else "sticker" if mime == "image/webp" else "document")
    typ = ui.ask("Type (image/video/audio/document/sticker)", default=guess)
    body = {"to": to, "type": typ, "data_base64": base64.b64encode(path.read_bytes()).decode(),
            "filename": path.name, "mimetype": mime}
    cap = ui.ask("Caption (blank = none)")
    if cap:
        body["caption"] = cap
    if typ == "audio" and ui.confirm("Send as a voice note (push-to-talk)?", default=mime.endswith("ogg")):
        body["voice_note"] = True
    _remember(ctx, client.post(ctx, "/api/send/media", body))


def send_location(ctx):
    ui.explain("POST /api/send/location  {to, latitude, longitude, name?, address?}")
    to = common.pick_target(ctx)
    if not to:
        return
    lat = float(ui.ask("Latitude", default="19.0760"))
    lng = float(ui.ask("Longitude", default="72.8777"))
    _remember(ctx, client.post(ctx, "/api/send/location", {"to": to, "latitude": lat, "longitude": lng, "name": ui.ask("Place name", default="Mumbai")}))


def send_contact(ctx):
    ui.explain("POST /api/send/contact  {to, contacts:[{name, phone}]}")
    to = common.pick_target(ctx)
    if not to:
        return
    name = ui.ask("Contact name", required=True)
    phone = ui.numbers(ui.ask("Contact phone with country code", required=True))
    if phone:
        _remember(ctx, client.post(ctx, "/api/send/contact", {"to": to, "contacts": [{"name": name, "phone": phone[0]}]}))


def send_poll(ctx):
    ui.explain("POST /api/send/poll  {to, question, options, multi?}")
    to = common.pick_target(ctx)
    if not to:
        return
    q = ui.ask("Question", required=True)
    opts = [o.strip() for o in ui.ask("Options, separated by commas", default="Yes, No").split(",") if o.strip()]
    _remember(ctx, client.post(ctx, "/api/send/poll", {"to": to, "question": q, "options": opts, "multi": ui.confirm("Allow several answers?")}))


def react(ctx):
    ui.explain("POST /api/messages/:uid/react  {emoji}. An empty emoji removes your reaction.")
    uid = common.pick_uid(ctx)
    if uid:
        client.post(ctx, f"/api/messages/{uid}/react", {"emoji": ui.ask("Emoji (blank removes)", default="👍")})


def edit(ctx):
    ui.explain("POST /api/messages/:uid/edit  {text}. Only works on text messages sent by the linked number.")
    uid = common.pick_uid(ctx)
    if uid:
        client.post(ctx, f"/api/messages/{uid}/edit", {"text": ui.ask("New text", required=True)})


def delete(ctx):
    ui.explain("POST /api/messages/:uid/delete deletes your own message for everyone in the chat.")
    uid = common.pick_uid(ctx)
    if uid and ui.confirm(f"Delete message {uid} for everyone?"):
        client.post(ctx, f"/api/messages/{uid}/delete")


def mark_read(ctx):
    ui.explain("POST /api/messages/:uid/read sends a read receipt (blue ticks) to the sender.")
    uid = common.pick_uid(ctx)
    if uid and ui.confirm("This tells the sender you read it. Continue?"):
        client.post(ctx, f"/api/messages/{uid}/read")


def presence(ctx):
    ui.explain("POST /api/presence  {to, state}. State: composing (typing), recording, paused.")
    to = common.pick_target(ctx)
    if to:
        client.post(ctx, "/api/presence", {"to": to, "state": ui.ask("State", default="composing")})


def lookup(ctx):
    ui.explain("POST /api/lookup  {numbers}. Tells you which numbers are on WhatsApp. Run this before adding people.")
    nums = common.test_numbers(ctx, "Numbers to check (comma separated)")
    client.post(ctx, "/api/lookup", {"numbers": nums})


def menu(ctx):
    ui.menu("Send messages (admin key)", [
        ("Text message (with tags / reply)", lambda: send_text(ctx)),
        ("Photo / video / document / voice note from a file", lambda: send_media(ctx)),
        ("Location", lambda: send_location(ctx)),
        ("Contact card", lambda: send_contact(ctx)),
        ("Poll", lambda: send_poll(ctx)),
        ("React to a message", lambda: react(ctx)),
        ("Edit one of my messages", lambda: edit(ctx)),
        ("Delete one of my messages", lambda: delete(ctx)),
        ("Mark a message as read", lambda: mark_read(ctx)),
        ("Show 'typing...'", lambda: presence(ctx)),
        ("Check which numbers are on WhatsApp", lambda: lookup(ctx)),
    ], sub="Messages are real. Use your own test numbers.")
