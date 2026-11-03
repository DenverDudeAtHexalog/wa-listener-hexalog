"""HTTP layer. Every call prints the request (and an equivalent curl command) so developers can see exactly
what the API expects, then prints the result with a plain-language hint on errors."""
import json
import urllib.error
import urllib.parse
import urllib.request

from . import ui

HINTS = {
    401: "The API key was rejected. Check the key in Settings (read key for reading, admin key for writing).",
    403: "Not allowed. Either the admin key is missing/wrong, writes are disabled on the server "
         "(ADMIN_API_KEY not set), or the linked number is not an admin of that group.",
    404: "Not found. Check the group id / message uid.",
    410: "The file has expired on WhatsApp and can no longer be downloaded.",
    413: "The request body is too large.",
    429: "Rate limit reached (safety limits). Wait and try again later.",
    503: "WhatsApp is not connected right now. Link the number in the portal.",
    400: "Bad request. If it says several numbers can do this, pick one with  Choose which number to use  in the main menu.",
}


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


def request(ctx, method, path, body=None, admin=False, show=True, timeout=120):
    cfg = ctx.cfg
    key = cfg.admin_key if admin else cfg.api_key
    label = "admin key" if admin else "read key"
    if not key:
        ui.bad(f"No {label} set. Go to Settings from the main menu and enter it.")
        return Result(0, {"error": f"no {label}"})
    num = getattr(ctx, "number", None)
    if num and path.startswith("/api/") and not path.startswith("/api/numbers"):
        if method == "GET":
            if path.split("?")[0] in ("/api/groups", "/api/messages", "/api/actions") or path.startswith(("/api/groups/", "/api/messages")):
                path += ("&" if "?" in path else "?") + "number=" + urllib.parse.quote(str(num))
        elif isinstance(body, dict) and "number" not in body:
            body = dict(body, number=num)
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
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(url, data=data, method=method,
                                 headers={"x-api-key": key, "content-type": "application/json"})
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            raw = r.read()
            status = r.status
    except urllib.error.HTTPError as e:
        raw, status = e.read(), e.code
    except urllib.error.URLError as e:
        ui.bad(f"Cannot reach {cfg.url}: {e.reason}")
        ui.info("Check the URL in Settings, that the server is running, and that port 3000 is open to you.")
        return Result(0, {"error": str(e.reason)})
    except TimeoutError:
        ui.bad("Timed out waiting for the server.")
        return Result(0, {"error": "timeout"})
    try:
        parsed = json.loads(raw or b"{}")
    except ValueError:
        parsed = {"raw": raw[:500].decode("utf-8", "replace")}
    res = Result(status, parsed)
    if show:
        (ui.good if res.ok else ui.bad)(f"HTTP {status}")
        ui.pretty(parsed)
        if not res.ok:
            hint = HINTS.get(status)
            if hint:
                ui.warn(hint)
    return res


def get(ctx, path, **kw):
    return request(ctx, "GET", path, **kw)


def post(ctx, path, body=None, admin=True, **kw):
    return request(ctx, "POST", path, body if body is not None else {}, admin=admin, **kw)


def put(ctx, path, body=None, admin=True, **kw):
    return request(ctx, "PUT", path, body if body is not None else {}, admin=admin, **kw)


def delete(ctx, path, admin=True, **kw):
    return request(ctx, "DELETE", path, admin=admin, **kw)


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
