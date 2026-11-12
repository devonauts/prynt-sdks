"""Prynt Python server SDK.

Verify a browser identification from your backend using your SECRET key — never trust the
browser's response body alone.

    from prynt import PryntServer
    prynt = PryntServer(secret_key=os.environ["PRYNT_SECRET_KEY"])
    event = prynt.get_event(request_id)
    if event["smartSignals"]["bot"]["result"]:
        block_request()
    if event["accountsOnDevice"]["count"] > 0:      # multi-accounting at signup
        review_signup()
    prynt.update_event(request_id, linked_id=str(user.id))   # after the account exists
"""
import json
import socket
import urllib.error
import urllib.parse
import urllib.request
from typing import List, Optional, TypedDict

__all__ = ["PryntServer", "PryntError", "DEFAULT_ENDPOINT", "AccountOnDevice", "AccountsOnDevice"]
__version__ = "1.0.0"

DEFAULT_ENDPOINT = "https://api.pryntid.com"


class AccountOnDevice(TypedDict):
    """One of your accounts (a linkedId) seen on the device."""
    linkedId: str
    events: int
    firstSeenAt: Optional[str]
    lastSeenAt: Optional[str]


class AccountsOnDevice(TypedDict):
    """Every linkedId ever seen on the event's device, newest first (``event["accountsOnDevice"]``)."""
    count: int            # accounts listed (max 20)
    truncated: bool       # True when the device has more than were listed
    accounts: List[AccountOnDevice]


class PryntError(Exception):
    """API or network error. ``status`` is the HTTP status (None when the API was unreachable)."""

    def __init__(self, message, status=None, code=None):
        super().__init__(message)
        self.status = status
        self.code = code


class PryntServer:
    def __init__(self, secret_key, endpoint=DEFAULT_ENDPOINT, timeout=5):
        if not secret_key:
            raise ValueError("secret_key is required")
        if not secret_key.startswith("sk_"):
            raise ValueError("secret_key must start with sk_")
        self.secret_key = secret_key
        self.endpoint = (endpoint or DEFAULT_ENDPOINT).rstrip("/")
        self.timeout = timeout

    def _request(self, method, path, body=None):
        headers = {"Authorization": f"Bearer {self.secret_key}", "Accept": "application/json",
                   "User-Agent": f"prynt-python/{__version__}", "X-Prynt-SDK": f"python/{__version__}"}
        data = None
        if body is not None:
            data = json.dumps(body).encode()
            headers["Content-Type"] = "application/json"
        req = urllib.request.Request(self.endpoint + path, data=data, headers=headers, method=method)
        try:
            with urllib.request.urlopen(req, timeout=self.timeout) as resp:
                return json.loads(resp.read().decode())
        except urllib.error.HTTPError as e:
            try:
                err = json.loads(e.read().decode()).get("error") or {}
            except (ValueError, AttributeError):
                err = {}
            raise PryntError(err.get("message") or str(e), e.code, err.get("code")) from None
        except urllib.error.URLError as e:
            raise PryntError(f"network error: {e.reason}", code="network_error") from None
        except socket.timeout:
            raise PryntError(f"request timed out after {self.timeout}s", code="timeout") from None

    @staticmethod
    def _event_path(request_id):
        if not request_id:
            raise ValueError("request_id is required")
        return "/v1/events/" + urllib.parse.quote(str(request_id), safe="")

    def get_event(self, request_id):
        """Return the authoritative server-side record for a requestId (dict).

        Includes ``accountsOnDevice`` (see :class:`AccountsOnDevice`): every one of your account
        ids (linkedId) ever seen on the device that made the request.
        """
        return self._request("GET", self._event_path(request_id))

    def update_event(self, request_id, linked_id):
        """Attach your account id to an identification after the fact — typically right after
        signup, when the browser identified before the user id existed. From then on the
        device's ``accountsOnDevice`` includes it.

        Returns ``{"requestId", "visitorId", "linkedId", "accountsOnDevice"}``.
        """
        path = self._event_path(request_id)
        if not isinstance(linked_id, str) or not linked_id.strip():
            raise ValueError("linked_id must be a non-empty string")
        return self._request("PUT", path, {"linkedId": linked_id})

    def is_bot(self, request_id):
        event = self.get_event(request_id)
        return bool(event.get("smartSignals", {}).get("bot", {}).get("result"))
