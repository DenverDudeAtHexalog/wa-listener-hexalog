"""Tiny terminal helpers: prompts, menus, headings, JSON printing."""
import json
import re
import sys

WIDTH = 78


class Quit(Exception):
    """Raised when input ends (Ctrl+D / closed stdin)."""


def line(ch="-"):
    print(ch * WIDTH)


def header(title, sub=None):
    print()
    line("=")
    print(" " + title)
    if sub:
        print(" " + sub)
    line("=")


def info(msg):
    print("  " + msg)


def good(msg):
    print("  [OK]   " + msg)


def bad(msg):
    print("  [FAIL] " + msg)


def warn(msg):
    print("  [!]    " + msg)


def explain(text):
    """A short 'what is about to happen' note shown before an API call."""
    for ln in text.strip().splitlines():
        print("  | " + ln.strip())


def ask(prompt, default=None, required=False):
    suffix = f" [{default}]" if default not in (None, "") else ""
    while True:
        try:
            v = input(f"  > {prompt}{suffix}: ").strip()
        except (EOFError, KeyboardInterrupt):
            raise Quit()
        if not v and default is not None:
            return str(default)
        if v or not required:
            return v
        print("    (a value is required)")


def confirm(prompt, default=False):
    d = "Y/n" if default else "y/N"
    try:
        v = input(f"  > {prompt} [{d}]: ").strip().lower()
    except (EOFError, KeyboardInterrupt):
        raise Quit()
    return default if not v else v.startswith("y")


def pause(msg="Press Enter to continue"):
    try:
        input(f"  ... {msg} ")
    except (EOFError, KeyboardInterrupt):
        raise Quit()


def numbers(text):
    """'+91 98000 00001, 919800000002' -> ['919800000001', '919800000002']"""
    out = []
    for part in re.split(r"[,\s;]+", text or ""):
        d = re.sub(r"\D", "", part)
        if d:
            out.append(d)
    return out


def pretty(obj, limit=2500):
    s = json.dumps(obj, indent=2, ensure_ascii=False, default=str)
    if len(s) > limit:
        s = s[:limit] + f"\n  … (+{len(s) - limit} more characters)"
    print("\n".join("  " + ln for ln in s.splitlines()))


def menu(title, items, sub=None, back="Back"):
    """items: list of (label, function). Runs until the user picks 0. Each function gets no arguments."""
    while True:
        header(title, sub)
        for i, (label, _) in enumerate(items, 1):
            print(f"  {i:>2}) {label}")
        print(f"   0) {back}")
        c = ask("Choose")
        if c in ("0", "", "q", "b"):
            return
        if not c.isdigit() or not 1 <= int(c) <= len(items):
            warn("Pick one of the numbers above.")
            continue
        try:
            items[int(c) - 1][1]()
        except KeyboardInterrupt:
            print("\n  (cancelled)")
        except Quit:
            raise
        try:
            pause("Press Enter to return to the menu")
        except Quit:
            raise
