# Prynt Python SDK (`pryntid`)

Prynt Python server SDK — verify visitor identifications server-side with your **secret** key.
Python 3.8+, standard library only.

```bash
pip install pryntid
```

The import name is `prynt`:

```python
import os
from prynt import PryntServer

prynt = PryntServer(secret_key=os.environ["PRYNT_SECRET_KEY"])   # sk_live_...
event = prynt.get_event(request_id)   # the requestId your browser code sent you

if event["decision"] == "block" or event["smartSignals"]["bot"]["result"]:
    block_request()
print(event["visitorId"], event["confidence"]["score"])
```

`endpoint` defaults to Prynt Cloud (`https://api.pryntid.com`); pass
`endpoint="https://your-prynt-server"` only when self-hosting. `timeout` is in seconds (default 5).

## Signup abuse: accounts on this device

`get_event()` includes `accountsOnDevice` — every one of your account ids (`linkedId`) ever seen
on the device that made the request. After creating the account, attach its id with
`update_event()` so the next signup from the same device sees it:

```python
event = prynt.get_event(form["pryntRequestId"])
if event["decision"] == "block":
    abort(403)
if event["accountsOnDevice"]["count"] >= 1:
    # e.g. one free trial per device: refuse, require verification, or flag for review
    abort(409, "This device already has an account")

user = create_user(form)
prynt.update_event(form["pryntRequestId"], linked_id=str(user.id))
```

```python
event["accountsOnDevice"] == {
    "count": 2,            # accounts listed (max 20)
    "truncated": False,    # True when more than 20 exist
    "accounts": [{"linkedId": "user_123", "events": 7,
                  "firstSeenAt": "2026-10-01T12:00:00Z", "lastSeenAt": "2026-10-05T09:30:00Z"}, ...],
}
```

`update_event(request_id, linked_id)` returns
`{"requestId", "visitorId", "linkedId", "accountsOnDevice"}`.

Never trust the browser's `identify()` response alone — always confirm with `get_event`.
Errors raise `PryntError` with `.status` (HTTP status, `None` if the API was unreachable) and
`.code` (e.g. `not_found`, `invalid_key`, `network_error`, `timeout`).

## Tests

```bash
python -m unittest discover -s tests
```

MIT © Prynt
