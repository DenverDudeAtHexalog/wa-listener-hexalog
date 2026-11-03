# API test console

An interactive menu for developers to try every endpoint of the WhatsApp Listener API without writing requests by hand.
Python 3.8+, nothing to install.

```
python scripts/try_api.py
```

In PyCharm: right-click `scripts/try_api.py` → Run. Type the menu number in the Run window and press Enter.

## First time

1. Menu **Settings**: enter the server URL, the **read key** (`API_KEY`) and the **admin key** (`ADMIN_API_KEY`).
   To add or link numbers from the console, also enter the **portal password** (`PORTAL_PASSWORD`).
   They are saved in `~/.wa_api_tester.json` in your home folder, never in the repo.
   (`WA_URL`, `WA_KEY`, `WA_ADMIN`, `WA_PORTAL` environment variables also work and take priority.)
2. Make sure a number is linked: menu **Numbers → Add a new number and link it** (QR code or pairing code),
   or open the server URL in a browser and use the portal.
3. Menu **Connection check**, then **Guided walkthrough**.
4. Several numbers? Menu **Numbers** lists them and lets you pick which one the console sends from and filters by.
   If you forget, the console asks you when the server answers "several numbers are connected".

## What is in the menu

| Menu | What it covers | Key |
|---|---|---|
| Guided walkthrough | 15 explained steps: choose the number, create a test group, send text/poll/location, react, edit, rename, promote/demote, invite link, read back, audit log, clean up | both |
| Connection check | server reachable, which numbers are connected, both keys valid | both |
| Numbers | list numbers and their status, choose the one the console uses, **add a number, link it by QR code or pairing code, pause, unlink, rename, delete** | read key to list/choose; portal password to add/link/remove |
| Read | groups (with the numbers that are in each), messages with filters, one message, new-messages cursor, download files, transcripts | read |
| Send | text (tags, replies), files and voice notes, location, contact, poll, react, edit, delete, read receipt, typing, number lookup | admin |
| Manage groups | create, add/remove, promote/demote, rename, description, settings, picture, invite link, join, join requests, leave | admin |
| Profile | display name, About, picture, audit log (shows the number each action ran on) | admin |
| Live events | watch the event stream (all numbers, or one), create/list/delete webhooks, signature verification code | read |

Every call shows the request, an equivalent `curl` command, the response, and a plain-language hint when it fails.

## Several numbers

- `GET /api/numbers` lists them; every message, group and audit row says which number (`number_id`) it belongs to.
- Reads cover all numbers; add `?number=<id or phone>` to narrow to one. The Numbers menu sets this for the whole session.
- Writes (send, group and profile changes) run on one number: put `number` (id or phone) in the body. If only one number can
  do it the server picks it; otherwise it answers 400 with the list, and the console asks which one and retries.
- **Adding, linking and removing numbers is portal-only** (`/portal/...`, signed in with the portal password), not the API keys.
  The console signs in for you. QR codes open as a self-refreshing page in your browser; a pairing code is printed in the window.
- A number can only be deleted when it is unlinked and has no stored messages (the server answers 409 otherwise).

## Code layout

```
scripts/try_api.py            launcher
scripts/api_tester/app.py     main menu
scripts/api_tester/client.py  HTTP calls (API keys and portal login), request/curl printing, error hints, number selection
scripts/api_tester/config.py  saved settings + session memory (last group, last message)
scripts/api_tester/ui.py      prompts and menus
scripts/api_tester/flows/     one file per menu: read, send, groups, profile, live, numbers, setup, guided
```

To add an endpoint, write a function in the matching `flows/` file (copy a nearby one) and add one line to that file's `menu()`.

## Safety

These are real WhatsApp actions. Use your own test numbers, keep volumes small, and never run bulk loops on a real client number:
the server paces actions and enforces limits, but WhatsApp can still ban a number that behaves like a bot.
