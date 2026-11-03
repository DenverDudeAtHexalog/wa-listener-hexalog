"""HTTP layer. Every call prints the request (and an equivalent curl command) so developers can see exactly
what the API expects, then prints the result with a plain-language hint on errors.

Two kinds of calls:
  request()/get()/post()...  the API (x-api-key: read key or admin key)
  portal()                   the portal routes that add / link / rename / remove WhatsApp numbers.
                             These use the portal password (a login cookie), not an API key."""
import http.cookiejar
import json
import urllib.error
import urllib.parse
import urllib.request

from . import ui

HINTS = {
    401: "The API key was rejected. Check the key in Settings (read key for reading, admin key for writing).",
    403: "Not allowed. Either the admin key is missing/wrong, writes are disabled on the server "
         "(ADMIN_API_KEY not set), or the linked number is not an admin of that group.",
    404: "Not found. Check the group id / message uid / number id.",
    409: "The server refused this in the current state (for example a number must be unlinked before it can be "
         "deleted, a number with stored messages cannot be deleted, or the number limit is reached).",
    410: "The file has expired on WhatsApp and can no longer be downloaded.",
    413: "The request body is too large.",
    429: "Rate limit reached (safety limits). Wait and try again later.",
    503: "WhatsApp is not connected right now for that number. Link it in the Numbers menu (or the portal).",
    400: "Bad request. If it says several numbers are connected, pick one in the Numbers menu "
         "(Choose which number to use).",
}

# What the server calls each connection state, in plain words.
STATE = {"open": "connected", "idle": "not connected", "qr": "waiting for QR scan", "connecting": "connecting",
         "reconnecting": "reconnecting", "logged_out": "unlinked", "replaced": "used elsewhere",
         "pairing": "waiting for pairing code"}


class Result:
    def __init__(self, status, body):
        self.status = status
        self.body = body if isinstance(body, dict) else {"data": body}

    @property
    def ok(self):
        return 200 <= self.status < 300

    def get(self, *keys, default=None):
        cur = self.body
        for k in keys:
            if isinstance(cur, dict) and k in cur:
                cur = cur[k]
            else:
                return default
        return cur


def qs(**kw):
    clean = {k: v for k, v in kw.items() if v not in (None, "")}
    return ("?" + urllib.parse.urlencode(clean)) if clean else ""


def enc(jid):
    return urllib.parse.quote(jid, safe="")


def _short(body):
    """Shorten big base64 fields for display."""
    if isinstance(body, dict):
        return {k: (f"<{len(v)} chars of base64>" if k == "data_base64" and isinstance(v, str) else v) for k, v in body.items()}
    return body


# Routes where the server does not look at a `number`, so the console does not add one.
_NO_NUMBER = ("/api/numbers", "/api/status", "/api/webhooks", "/api/media")


def _with_number(ctx, method, path, body):
    """When a number has been chosen (Numbers menu), add it to the request the way the server expects:
    in the query string for GET and DELETE, in the JSON body for POST and PUT."""
    num = getattr(ctx, "number", None)
    if not num or not path.startswith("/api/") or path.startswith(_NO_NUMBER) or path.split("?")[0].endswith("/transcript"):
        return path, body
    if method in ("GET", "DELETE"):
        if "number=" not in path:
            path += ("&" if "?" in path else "?") + "number=" + urllib.parse.quote(str(num))
    elif isinstance(body, dict) and "number" not in body:
        body = dict(body, number=num)
    return path, body


def _send(method, url, headers, body, timeout, opener=None, base=""):
    """One HTTP call. Returns a Result; never raises for HTTP errors or network problems."""
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(url, data=data, method=method, headers=headers)
    try:
        with (opener.open(req, timeout=timeout) if opener else urllib.request.urlopen(req, timeout=timeout)) as r:
            raw, status = r.read(), r.status
    except urllib.error.HTTPError as e:
        raw, status = e.read(), e.code
    except urllib.error.URLError as e:
        ui.bad(f"Cannot reach {base or url}: {e.reason}")
        ui.info("Check the URL in Settings, that the server is running, and that port 3000 is open to you.")
        return Result(0, {"error": str(e.reason)})
    except TimeoutError:
        ui.bad("Timed out waiting for the server.")
        return Result(0, {"error": "timeout"})
    try:
        parsed = json.loads(raw or b"{}")
    except ValueError:
        parsed = {"raw": raw[:500].decode("utf-8", "replace")}
    return Result(status, parsed)


def _show_result(res):
    (ui.good if res.ok else ui.bad)(f"HTTP {res.status}")
    ui.pretty(res.body)
    if not res.ok:
        hint = HINTS.get(res.status)
        if hint:
            ui.warn(hint)


def _ambiguous(res):
    """The server answers 400 with the list of numbers when several are connected and none was chosen."""
    return res.status == 400 and isinstance(res.get("numbers"), list) and "several numbers" in str(res.get("error", default=""))


def _pick_inline(ctx, nums):
    """The server could not tell which number to use: let the user pick one now (kept for the session)."""
    open_ = [n for n in nums if n.get("linked")] or nums
    print()
    ui.warn("Several numbers are connected, so the server needs to know which one to use for this action.")
    for n in open_:
        ui.info(f"{n['id']}) {n.get('label')}  {n.get('phone') or ''}  [{STATE.get(n.get('state'), n.get('state'))}]")
    c = ui.ask("Number id to use (blank = cancel)", default="")
    if c.isdigit() and any(str(n["id"]) == c for n in open_):
        ctx.number = c
        ui.good(f"Using number {c} from now on. Change it any time in the Numbers menu.")
        return True
    return False


def request(ctx, method, path, body=None, admin=False, show=True, timeout=120, _retry=True):
    cfg = ctx.cfg
    key = cfg.admin_key if admin else cfg.api_key
    label = "admin key" if admin else "read key"
    if not key:
        ui.bad(f"No {label} set. Go to Settings from the main menu and enter it.")
        return Result(0, {"error": f"no {label}"})
    orig_path, orig_body = path, body
    path, body = _with_number(ctx, method, path, body)
    url = cfg.url + path
    if show:
        print()
        print(f"  --> {method} {path}   (uses the {label})")
        if body is not None:
            ui.pretty(_short(body), 1200)
        if cfg.show_curl:
            var = "$ADMIN_API_KEY" if admin else "$API_KEY"
            cmd = f'curl -X {method} "{url}" -H "x-api-key: {var}"'
            if body is not None:
                cmd += ' -H "content-type: application/json" -d \'' + json.dumps(_short(body), ensure_ascii=False) + "'"
            print("  curl equivalent: " + cmd)
    res = _send(method, url, {"x-api-key": key, "content-type": "application/json"}, body, timeout, base=cfg.url)
    if show:
        _show_result(res)
        if _retry and _ambiguous(res) and _pick_inline(ctx, res.get("numbers")):
            return request(ctx, method, orig_path, orig_body, admin=admin, show=show, timeout=timeout, _retry=False)
    return res


def get(ctx, path, **kw):
    return request(ctx, "GET", path, **kw)


def post(ctx, path, body=None, admin=True, **kw):
    return request(ctx, "POST", path, body if body is not None else {}, admin=admin, **kw)


def put(ctx, path, body=None, admin=True, **kw):
    return request(ctx, "PUT", path, body if body is not None else {}, admin=admin, **kw)


def delete(ctx, path, admin=True, **kw):
    return request(ctx, "DELETE", path, admin=admin, **kw)


# ---- portal (numbers: add, link, rename, pause, unlink, delete) --------------------------------------------------

def _portal_login(ctx):
    cfg = ctx.cfg
    if ctx.portal is None:
        ctx.portal = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(http.cookiejar.CookieJar()))
    res = _send("POST", cfg.url + "/portal/login", {"content-type": "application/json"},
                {"password": cfg.portal_password}, 30, opener=ctx.portal, base=cfg.url)
    if res.ok:
        ctx.portal_ok = True
        return True
    if res.status == 401:
        ui.bad("The portal password was rejected. Check it in Settings (PORTAL_PASSWORD on the server).")
    elif res.status == 429:
        ui.bad("Too many wrong passwords. Wait a minute and try again.")
    elif res.status:
        ui.bad(f"Portal login failed (HTTP {res.status}).")
    return False


def portal(ctx, method, path, body=None, show=True, timeout=60):
    """Call a /portal/... route. Logs in with the portal password first (and again if the session expired).
    Adding, linking and removing numbers is portal-only: the API keys cannot do it."""
    cfg = ctx.cfg
    if not cfg.portal_password:
        ui.bad("No portal password set. Go to Settings from the main menu and enter it (PORTAL_PASSWORD on the server).")
        return Result(0, {"error": "no portal password"})
    if show:
        print()
        print(f"  --> {method} {path}   (uses the portal password)")
        if body is not None:
            ui.pretty(body, 1200)
        if cfg.show_curl:
            print(f'  curl equivalent: curl -c wl.txt -X POST "{cfg.url}/portal/login" -H "content-type: application/json" -d \'{{"password":"$PORTAL_PASSWORD"}}\'')
            cmd = f'curl -b wl.txt -X {method} "{cfg.url}{path}"'
            if body is not None:
                cmd += ' -H "content-type: application/json" -d \'' + json.dumps(body, ensure_ascii=False) + "'"
            print("                   " + cmd)
    if not ctx.portal_ok and not _portal_login(ctx):
        return Result(0, {"error": "portal login failed"})
    res = _send(method, cfg.url + path, {"content-type": "application/json"}, body, timeout, opener=ctx.portal, base=cfg.url)
    if res.status == 401:  # the 12-hour session ran out: log in again once
        ctx.portal_ok = False
        if _portal_login(ctx):
            res = _send(method, cfg.url + path, {"content-type": "application/json"}, body, timeout, opener=ctx.portal, base=cfg.url)
    if show:
        _show_result(res)
    return res


def download(ctx, path, dest):
    """Fetch a binary file (media). Returns (status, bytes_written_or_error)."""
    req = urllib.request.Request(ctx.cfg.url + path, headers={"x-api-key": ctx.cfg.api_key})
    try:
        with urllib.request.urlopen(req, timeout=120) as r:
            data = r.read()
            ctype = r.headers.get("content-type", "")
        dest.parent.mkdir(parents=True, exist_ok=True)
        dest.write_bytes(data)
        return 200, len(data), ctype
    except urllib.error.HTTPError as e:
        try:
            msg = json.loads(e.read()).get("error", "")
        except Exception:
            msg = ""
        return e.code, msg, ""
    except urllib.error.URLError as e:
        return 0, str(e.reason), ""
