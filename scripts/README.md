# API test console

An interactive menu for developers to try every endpoint of the WhatsApp Listener API without writing requests by hand.
Python 3.8+, nothing to install.

```
python scripts/try_api.py
```

In PyCharm: right-click `scripts/try_api.py` → Run. Type the menu number in the Run window and press Enter.

## First time

1. Menu **Settings**: enter the server URL, the **read key** (`API_KEY`) and the **admin key** (`ADMIN_API_KEY`).
   They are saved in `~/.wa_api_tester.json` in your home folder, never in the repo.
   (`WA_URL`, `WA_KEY`, `WA_ADMIN` environment variables also work and take priority.)
2. Make sure the number is linked: open the server URL in a browser and scan the QR code in the portal.
3. Menu **Connection check**, then **Guided walkthrough**.
4. Several numbers? Menu **Numbers** lists them and lets you pick which one the console sends from and filters by.

## What is in the menu

| Menu | What it covers | Key |
|---|---|---|
| Guided walkthrough | 14 explained steps: create a test group, send text/poll/location, react, edit, rename, promote/demote, invite link, read back, audit log, clean up | both |
| Connection check | server reachable, number linked, both keys valid | both |
| Read | groups, messages with filters, one message, new-messages cursor, download files, transcripts | read |
| Send | text (tags, replies), files and voice notes, location, contact, poll, react, edit, delete, read receipt, typing, number lookup | admin |
| Manage groups | create, add/remove, promote/demote, rename, description, settings, picture, invite link, join, join requests, leave | admin |
| Profile | display name, About, picture, audit log | admin |
| Live events | watch the event stream, create/list/delete webhooks, signature verification code | read |

Every call shows the request, an equivalent `curl` command, the response, and a plain-language hint when it fails.

## Code layout

```
scripts/try_api.py            launcher
scripts/api_tester/app.py     main menu
scripts/api_tester/client.py  HTTP calls, request/curl printing, error hints
scripts/api_tester/config.py  saved settings + session memory (last group, last message)
scripts/api_tester/ui.py      prompts and menus
scripts/api_tester/flows/     one file per menu: read, send, groups, profile, live, setup, guided
```

To add an endpoint, write a function in the matching `flows/` file (copy a nearby one) and add one line to that file's `menu()`.

## Safety

These are real WhatsApp actions. Use your own test numbers, keep volumes small, and never run bulk loops on a real client number:
the server paces actions and enforces limits, but WhatsApp can still ban a number that behaves like a bot.
