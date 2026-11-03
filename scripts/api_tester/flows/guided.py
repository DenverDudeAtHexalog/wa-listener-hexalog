"""Guided walkthrough: runs the whole API in a sensible order, explaining each step and pausing between them.
It creates a throwaway test group with your own test numbers and offers to clean up at the end."""
import time

from .. import client, ui
from ..client import enc
from . import common, setup

TOTAL = 14


class Stop(Exception):
    pass


def _step(n, title, why):
    ui.header(f"Step {n} of {TOTAL}: {title}")
    ui.explain(why)
    c = ui.ask("Enter = run this step, s = skip, q = stop the walkthrough", default="")
    if c.lower().startswith("q"):
        raise Stop()
    return not c.lower().startswith("s")


def _last_sent_uid(ctx, jid):
    """Our own sent messages are stored too (from_me). Look the newest one up when the send reply had no uid."""
    for _ in range(4):
        r = client.get(ctx, f"/api/groups/{enc(jid)}/messages?limit=10", show=False)
        for m in r.get("messages", default=[]):
            if m.get("from_me"):
                return m["uid"]
        time.sleep(2)
    return None


def run(ctx):
    ui.header("Guided walkthrough", "Everything the API can do, in order. You decide when to move on.")
    ui.info("What happens: you create a TEST group with numbers you own, send a few messages into it,")
    ui.info("change it, read it back, and clean up. Nothing touches your real client groups.")
    ui.warn("Use your own numbers. Real WhatsApp messages and groups are created. Takes about 5 minutes.")
    if not ui.confirm("Start?", default=True):
        return
    state = {"jid": None, "uid": None}
    try:
        # 1
        if _step(1, "Check the connection and keys", "Confirms the server answers, the number is linked, and both keys work."):
            if not setup.check_everything(ctx):
                ui.warn("Fix the connection first (see the messages above), then run the walkthrough again.")
                return
        # 2
        if _step(2, "Read: list groups", "GET /api/groups. Read key. This is how your system discovers which groups exist."):
            client.get(ctx, "/api/groups")
        # 3
        if _step(3, "Read: recent messages across all groups",
                 "GET /api/messages?limit=5. Read key. Each message has a uid you can use later to react, edit or fetch files."):
            client.get(ctx, "/api/messages?limit=5")
        # 4
        nums = None
        if _step(4, "Check your test numbers are on WhatsApp",
                 "POST /api/lookup. Admin key. Always do this before adding people to a group."):
            nums = common.test_numbers(ctx, "Your test numbers (comma separated, with country code)")
            client.post(ctx, "/api/lookup", {"numbers": nums})
        # 5
        if _step(5, "Create a test group", "POST /api/groups. Admin key. The linked number becomes admin. Paced by the server, may take 10+ seconds."):
            nums = nums or common.test_numbers(ctx)
            name = "API test " + time.strftime("%H:%M")
            r = client.post(ctx, "/api/groups", {"subject": name, "participants": nums})
            if r.ok:
                state["jid"] = ctx.last_group = r.get("jid")
        if not state["jid"]:
            ui.warn("No test group yet, so the next steps need one. Pick an existing group (a test one!) or stop here.")
            if not ui.confirm("Pick an existing group to use?"):
                return
            state["jid"] = common.pick_group(ctx)
            if not state["jid"]:
                return
        jid = state["jid"]
        # 6
        if _step(6, "Send a text message", "POST /api/send/text. The reply includes the message uid."):
            r = client.post(ctx, "/api/send/text", {"to": jid, "text": "Hello from the API walkthrough"})
            state["uid"] = r.get("uid") if r.ok else None
        # 7
        if _step(7, "Send a poll", "POST /api/send/poll. Polls, locations, contacts and files all work the same way."):
            client.post(ctx, "/api/send/poll", {"to": jid, "question": "Is the API working?", "options": ["Yes", "No"]})
        # 8
        if _step(8, "Send a location", "POST /api/send/location."):
            client.post(ctx, "/api/send/location", {"to": jid, "latitude": 19.076, "longitude": 72.8777, "name": "Mumbai"})
        # 9
        if _step(9, "React to and edit your text message",
                 "POST /api/messages/:uid/react and /edit. These use the uid of a message the linked number sent."):
            uid = state["uid"] or _last_sent_uid(ctx, jid)
            if uid:
                client.post(ctx, f"/api/messages/{uid}/react", {"emoji": "👍"})
                client.post(ctx, f"/api/messages/{uid}/edit", {"text": "Hello from the API walkthrough (edited)"})
                state["uid"] = uid
            else:
                ui.warn("Could not find the message uid, skipping.")
        # 10
        if _step(10, "Rename the group and set a description", "PUT /api/groups/:jid/subject and /description."):
            client.put(ctx, f"/api/groups/{enc(jid)}/subject", {"subject": "API test (renamed)"})
            client.put(ctx, f"/api/groups/{enc(jid)}/description", {"description": "Created by the API walkthrough"})
        # 11
        if _step(11, "Make someone admin, then remove admin again",
                 "POST /api/groups/:jid/participants with action promote, then demote. Needs a number that is in the group."):
            nums = nums or common.test_numbers(ctx)
            client.post(ctx, f"/api/groups/{enc(jid)}/participants", {"action": "promote", "participants": nums[:1]})
            client.post(ctx, f"/api/groups/{enc(jid)}/participants", {"action": "demote", "participants": nums[:1]})
        # 12
        if _step(12, "Get the invite link", "GET /api/groups/:jid/invite. Anyone with the link can join, so treat it as sensitive."):
            client.get(ctx, f"/api/groups/{enc(jid)}/invite", admin=True)
        # 13
        if _step(13, "Read the group back, and see the audit log",
                 "Messages the number sends are stored like any other (from_me = true). GET /api/actions lists every\n"
                 "write you did through the API."):
            time.sleep(2)
            r = client.get(ctx, f"/api/groups/{enc(jid)}/messages?limit=10", show=False)
            for m in reversed(r.get("messages", default=[])):
                ui.info(common.one_line(m))
            client.get(ctx, "/api/actions?limit=10", admin=True)
        # 14
        if _step(14, "Clean up", "Delete the text message for everyone and leave the test group."):
            if state["uid"] and ui.confirm("Delete the text message for everyone?", default=True):
                client.post(ctx, f"/api/messages/{state['uid']}/delete")
            if ui.confirm("Leave the test group now?", default=True):
                client.post(ctx, f"/api/groups/{enc(jid)}/leave")
                ctx.last_group = None
        ui.header("Walkthrough finished", "Next: try single actions from the main menu, or 'Live events' to watch messages arrive.")
    except Stop:
        ui.info("Stopped. The test group (if one was created) is still on WhatsApp; leave it from the 'Manage groups' menu.")
