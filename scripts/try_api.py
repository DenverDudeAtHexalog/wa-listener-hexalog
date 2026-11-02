#!/usr/bin/env python3
"""
Try the WhatsApp Listener API from your own computer. Standard library only (Python 3.8+).

Set these first (PowerShell):
    $env:WA_URL   = "http://15.207.167.135:3000"
    $env:WA_KEY   = "<API_KEY>"          # read key
    $env:WA_ADMIN = "<ADMIN_API_KEY>"    # write key (needed for anything that sends or changes groups)

Examples:
    python try_api.py status
    python try_api.py groups
    python try_api.py messages --limit 5
    python try_api.py lookup 919800000001 919800000002
    python try_api.py full-test --numbers 919800000001          # creates a TEST group, runs everything, leaves it
    python try_api.py send 1203630xxxx@g.us "hello from the API"
    python try_api.py create-group "My test" 919800000001
    python try_api.py add   <group_jid> 919800000002
    python try_api.py promote <group_jid> 919800000002
    python try_api.py rename  <group_jid> "New name"
    python try_api.py invite  <group_jid>
    python try_api.py leave   <group_jid>

Use a few of your own numbers while testing. Automated group work on a real number can get it banned.
"""
import argparse, json, os, sys, time, urllib.request, urllib.error, urllib.parse

BASE = os.environ.get("WA_URL", "http://15.207.167.135:3000").rstrip("/")
KEY = os.environ.get("WA_KEY", "")
ADMIN = os.environ.get("WA_ADMIN", "")


def call(method, path, body=None, admin=False):
    key = ADMIN if admin else KEY
    if not key:
        sys.exit(f"Missing {'WA_ADMIN' if admin else 'WA_KEY'} environment variable.")
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(BASE + path, data=data, method=method,
                                 headers={"x-api-key": key, "content-type": "application/json"})
    try:
        with urllib.request.urlopen(req, timeout=120) as r:
            return r.status, json.loads(r.read() or b"{}")
    except urllib.error.HTTPError as e:
        try:
            return e.code, json.loads(e.read() or b"{}")
        except Exception:
            return e.code, {"error": str(e)}
    except urllib.error.URLError as e:
        sys.exit(f"Cannot reach {BASE}: {e.reason}")


def show(title, res):
    status, body = res
    mark = "OK  " if 200 <= status < 300 else "FAIL"
    print(f"[{mark}] {title}  (HTTP {status})")
    print(json.dumps(body, indent=2, ensure_ascii=False)[:1500])
    print()
    return 200 <= status < 300, body


def q(**kw):
    return "?" + urllib.parse.urlencode({k: v for k, v in kw.items() if v is not None})


def enc(jid):
    return urllib.parse.quote(jid, safe="")


def full_test(numbers):
    print(f"Server: {BASE}\n")
    ok, st = show("status", call("GET", "/api/status"))
    if not ok or st.get("state") != "open":
        sys.exit("WhatsApp is not connected. Link the number in the portal first.")

    ok, _ = show("lookup (are these numbers on WhatsApp?)", call("POST", "/api/lookup", {"numbers": numbers}, admin=True))
    if not ok:
        sys.exit("Admin key rejected or writes disabled. Check ADMIN_API_KEY on the server.")

    name = "API test " + time.strftime("%H:%M:%S")
    ok, g = show(f"create group '{name}'", call("POST", "/api/groups", {"subject": name, "participants": numbers}, admin=True))
    if not ok:
        sys.exit("Group creation failed, stopping.")
    jid = g.get("jid") or g.get("group", {}).get("jid") or g.get("id")
    if not jid:
        sys.exit("No group id in the response above; stopping.")
    print(f"Group: {jid}\n")
    time.sleep(3)

    show("send text", call("POST", "/api/send/text", {"to": jid, "text": "Hello from the API test"}, admin=True))
    show("send poll", call("POST", "/api/send/poll", {"to": jid, "question": "Is the API working?", "options": ["Yes", "No"]}, admin=True))
    show("send location", call("POST", "/api/send/location", {"to": jid, "latitude": 19.076, "longitude": 72.8777, "name": "Mumbai"}, admin=True))
    show("rename group", call("PUT", f"/api/groups/{enc(jid)}/subject", {"subject": name + " (renamed)"}, admin=True))
    show("set description", call("PUT", f"/api/groups/{enc(jid)}/description", {"description": "Created by the API test"}, admin=True))
    show("make first number admin", call("POST", f"/api/groups/{enc(jid)}/participants", {"action": "promote", "participants": numbers[:1]}, admin=True))
    show("demote them again", call("POST", f"/api/groups/{enc(jid)}/participants", {"action": "demote", "participants": numbers[:1]}, admin=True))
    show("invite link", call("GET", f"/api/groups/{enc(jid)}/invite", admin=True))
    time.sleep(2)
    show("read back messages", call("GET", f"/api/groups/{enc(jid)}/messages" + q(limit=10)))
    show("audit log", call("GET", "/api/actions" + q(limit=15), admin=True))

    if input("Leave the test group now? [y/N] ").strip().lower() == "y":
        show("leave group", call("POST", f"/api/groups/{enc(jid)}/leave", admin=True))
    else:
        print("Left it in place. Delete it from the phone when you are done.")


def main():
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = p.add_subparsers(dest="cmd", required=True)
    sub.add_parser("status"); sub.add_parser("groups")
    m = sub.add_parser("messages"); m.add_argument("--group"); m.add_argument("--limit", type=int, default=10); m.add_argument("--type")
    l = sub.add_parser("lookup"); l.add_argument("numbers", nargs="+")
    s = sub.add_parser("send"); s.add_argument("to"); s.add_argument("text")
    c = sub.add_parser("create-group"); c.add_argument("subject"); c.add_argument("numbers", nargs="+")
    for name in ("add", "remove", "promote", "demote"):
        a = sub.add_parser(name); a.add_argument("group"); a.add_argument("numbers", nargs="+")
    r = sub.add_parser("rename"); r.add_argument("group"); r.add_argument("subject")
    i = sub.add_parser("invite"); i.add_argument("group")
    lv = sub.add_parser("leave"); lv.add_argument("group")
    f = sub.add_parser("full-test"); f.add_argument("--numbers", nargs="+", required=True)
    a = p.parse_args()

    if a.cmd == "status": show("status", call("GET", "/api/status"))
    elif a.cmd == "groups": show("groups", call("GET", "/api/groups"))
    elif a.cmd == "messages":
        path = f"/api/groups/{enc(a.group)}/messages" if a.group else "/api/messages"
        show("messages", call("GET", path + q(limit=a.limit, type=a.type)))
    elif a.cmd == "lookup": show("lookup", call("POST", "/api/lookup", {"numbers": a.numbers}, admin=True))
    elif a.cmd == "send": show("send text", call("POST", "/api/send/text", {"to": a.to, "text": a.text}, admin=True))
    elif a.cmd == "create-group": show("create group", call("POST", "/api/groups", {"subject": a.subject, "participants": a.numbers}, admin=True))
    elif a.cmd in ("add", "remove", "promote", "demote"):
        show(a.cmd, call("POST", f"/api/groups/{enc(a.group)}/participants", {"action": a.cmd, "participants": a.numbers}, admin=True))
    elif a.cmd == "rename": show("rename", call("PUT", f"/api/groups/{enc(a.group)}/subject", {"subject": a.subject}, admin=True))
    elif a.cmd == "invite": show("invite", call("GET", f"/api/groups/{enc(a.group)}/invite", admin=True))
    elif a.cmd == "leave": show("leave", call("POST", f"/api/groups/{enc(a.group)}/leave", admin=True))
    elif a.cmd == "full-test": full_test(a.numbers)


if __name__ == "__main__":
    main()
