"""Shared pickers used by several menus."""
from .. import client, ui


def pick_group(ctx, prompt="Which group?"):
    """List the groups the number is in and let the user pick one (or paste a jid). Returns a jid or None."""
    res = client.get(ctx, "/api/groups", show=False)
    groups = res.get("groups", default=[]) if res.ok else []
    if res.status == 0 or res.status in (401, 403):
        client.get(ctx, "/api/groups")  # show the error properly
        return None
    print()
    if ctx.last_group:
        ui.info(f" L) last used: {ctx.last_group}")
    for i, g in enumerate(groups, 1):
        ui.info(f"{i:>2}) {g.get('subject') or '(no name)'}   [{g.get('participant_count', '?')} members]")
    if not groups:
        ui.info("(no groups yet; you can still paste a group id ending in @g.us)")
    c = ui.ask(f"{prompt} number, L for last, or paste a group id", default="L" if ctx.last_group else None, required=True)
    if c.lower() == "l" and ctx.last_group:
        return ctx.last_group
    if c.isdigit() and 1 <= int(c) <= len(groups):
        ctx.last_group = groups[int(c) - 1]["jid"]
        return ctx.last_group
    if "@g.us" in c:
        ctx.last_group = c
        return c
    ui.warn("That is not a listed number or a group id.")
    return None


def pick_target(ctx, prompt="Send to"):
    """A group (from the list) or a phone number. Returns a string for the API's `to` field, or None."""
    kind = ui.ask(f"{prompt}: (g)roup or (p)hone number", default="g")
    if kind.lower().startswith("p"):
        nums = ui.numbers(ui.ask("Phone number with country code, digits only (e.g. 919800000001)", required=True))
        return nums[0] if nums else None
    return pick_group(ctx)


def pick_uid(ctx, prompt="Message uid"):
    d = str(ctx.last_uid) if ctx.last_uid else None
    v = ui.ask(prompt + " (the number shown as #uid in message lists)", default=d, required=True)
    if not v.isdigit():
        ui.warn("A uid is a number.")
        return None
    ctx.last_uid = int(v)
    return int(v)


def test_numbers(ctx, prompt="Participant phone numbers (comma separated)"):
    saved = ", ".join(ctx.cfg.test_numbers)
    raw = ui.ask(prompt, default=saved or None, required=True)
    nums = ui.numbers(raw)
    if nums and nums != ctx.cfg.test_numbers:
        ctx.cfg.set(test_numbers=nums)
    return nums


def one_line(m):
    """Compact one-line summary of a message object."""
    who = m.get("sender_name") or m.get("sender_phone") or ("me" if m.get("from_me") else "?")
    t = (m.get("timestamp") or "")[:16].replace("T", " ")
    body = m.get("text") or ""
    media = m.get("media") or {}
    if media and not body:
        body = f"<{m.get('type')}{' ' + media['filename'] if media.get('filename') else ''}>"
    elif media:
        body += f"  <{m.get('type')}>"
    flags = (" (deleted)" if m.get("deleted") else "") + (" (edited)" if m.get("edited_at") else "")
    grp = f"{m.get('group_name') or ''}: " if m.get("group_name") else ""
    return f"#{m.get('uid')} {t} {grp}{who}: {body[:90]}{flags}"
