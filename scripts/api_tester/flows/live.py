"""Live events (server-sent events) and webhooks: the two ways to get messages pushed to you."""
import json
import urllib.error
import urllib.request

from .. import client, ui
from . import common

SIG_SNIPPET = '''import hmac, hashlib
def valid(raw_body: bytes, header: str, secret: str) -> bool:
    expected = "sha256=" + hmac.new(secret.encode(), raw_body, hashlib.sha256).hexdigest()
    return hmac.compare_digest(expected, header)   # header = X-Walistener-Signature'''


def watch(ctx):
    ui.explain("GET /api/stream is a Server-Sent Events connection. The server pushes message.created,\n"
               "message.updated, message.deleted, reaction, group.updated and connection events as they happen.\n"
               "Every event says which number it came from (number_id).\n"
               "Send a message in a WhatsApp group now and watch it appear here. Press Ctrl+C (or the stop button)\nto stop.")
    if not ctx.cfg.api_key:
        ui.bad("Set the read key in Settings first.")
        return
    path = "/api/stream" + (f"?number={ctx.number}" if ctx.number else "")
    ui.info("Watching " + (f"number {ctx.number} only." if ctx.number else "all numbers (pick one in the Numbers menu to narrow it)."))
    req = urllib.request.Request(ctx.cfg.url + path, headers={"x-api-key": ctx.cfg.api_key, "accept": "text/event-stream"})
    try:
        with urllib.request.urlopen(req, timeout=3600) as r:
            ui.good("Connected. Waiting for events...")
            event = "message"
            for raw in r:
                ln = raw.decode("utf-8", "replace").rstrip("\r\n")
                if ln.startswith("event:"):
                    event = ln[6:].strip()
                elif ln.startswith("data:"):
                    try:
                        data = json.loads(ln[5:].strip())
                    except ValueError:
                        data = ln[5:].strip()
                    if event.startswith("message") and isinstance(data, dict):
                        ui.info(f"[{event}] {common.one_line(data)}")
                    else:
                        ui.info(f"[{event}] {json.dumps(data, ensure_ascii=False)[:200]}")
                    event = "message"
    except urllib.error.HTTPError as e:
        ui.bad(f"HTTP {e.code}. {client.HINTS.get(e.code, '')}")
    except urllib.error.URLError as e:
        ui.bad(f"Cannot reach the server: {e.reason}")
    except KeyboardInterrupt:
        print()
        ui.info("Stopped watching.")


def list_hooks(ctx):
    ui.explain("GET /api/webhooks lists your webhooks.")
    client.get(ctx, "/api/webhooks")


def create_hook(ctx):
    ui.explain("POST /api/webhooks  {url, events}. The server will POST every matching event to your URL.\n"
               "The URL must be reachable FROM THE SERVER (a public https address). To just see deliveries,\n"
               "make a free temporary address at https://webhook.site and use that.\n"
               "The response shows the signing secret ONCE. Save it to verify signatures (see menu).")
    url = ui.ask("Webhook URL (https://...)", required=True)
    ev = [e.strip() for e in ui.ask("Events, comma separated (blank = all)", default="message.created").split(",") if e.strip()]
    client.post(ctx, "/api/webhooks", {"url": url, "events": ev}, admin=False)


def delete_hook(ctx):
    ui.explain("DELETE /api/webhooks/:id removes a webhook.")
    i = ui.ask("Webhook id", required=True)
    if ui.confirm(f"Delete webhook {i}?"):
        client.delete(ctx, f"/api/webhooks/{i}", admin=False)


def deliveries(ctx):
    ui.explain("GET /api/webhooks/:id/deliveries shows what was sent, the response and retries.")
    client.get(ctx, f"/api/webhooks/{ui.ask('Webhook id', required=True)}/deliveries")


def snippet(ctx):
    ui.explain("Every delivery has the header X-Walistener-Signature: sha256=<HMAC-SHA256 of the raw body>.\nVerify it like this before trusting a request:")
    print()
    for ln in SIG_SNIPPET.splitlines():
        print("      " + ln)
    ui.info("Failed deliveries are retried with growing delays (10 s up to 1 h, 8 attempts).")


def menu(ctx):
    ui.menu("Live events and webhooks (read key)", [
        ("Watch live events in this window", lambda: watch(ctx)),
        ("List webhooks", lambda: list_hooks(ctx)),
        ("Create a webhook", lambda: create_hook(ctx)),
        ("Show deliveries of a webhook", lambda: deliveries(ctx)),
        ("Delete a webhook", lambda: delete_hook(ctx)),
        ("How to verify the signature (code)", lambda: snippet(ctx)),
    ])
