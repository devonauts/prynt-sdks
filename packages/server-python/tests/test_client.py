"""Tests for the Prynt Python SDK against a local stub of the API (stdlib only).

    python -m unittest discover -s tests
"""
import json
import os
import sys
import threading
import unittest
from http.server import BaseHTTPRequestHandler, HTTPServer

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
from prynt import DEFAULT_ENDPOINT, PryntError, PryntServer  # noqa: E402

SK = "sk_test_abc"
ACCOUNTS = {"count": 1, "truncated": False, "accounts": [
    {"linkedId": "user_1", "events": 3, "firstSeenAt": "2026-10-01T00:00:00Z",
     "lastSeenAt": "2026-10-02T00:00:00Z"}]}
CALLS = []


class StubAPI(BaseHTTPRequestHandler):
    def log_message(self, *args):
        pass

    def _send(self, status, body):
        raw = json.dumps(body).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(raw)))
        self.end_headers()
        self.wfile.write(raw)

    def _handle(self):
        n = int(self.headers.get("Content-Length") or 0)
        body = json.loads(self.rfile.read(n)) if n else None
        CALLS.append({"method": self.command, "path": self.path, "body": body,
                      "auth": self.headers.get("Authorization"),
                      "type": self.headers.get("Content-Type")})
        if self.headers.get("Authorization") != f"Bearer {SK}":
            return self._send(401, {"error": {"code": "invalid_key", "message": "Unknown or disabled secret key"}})
        if self.path == "/v1/events/req_missing":
            return self._send(404, {"error": {"code": "not_found", "message": "No such requestId for this tenant"}})
        if self.command == "GET":
            return self._send(200, {"requestId": "req_1", "visitorId": "vis_1", "decision": "allow",
                                    "smartSignals": {"bot": {"result": False}},
                                    "accountsOnDevice": ACCOUNTS})
        return self._send(200, {"requestId": "req_1", "visitorId": "vis_1", "linkedId": body["linkedId"],
                                "accountsOnDevice": {"count": 2, "truncated": False, "accounts": [
                                    {"linkedId": body["linkedId"], "events": 1,
                                     "firstSeenAt": None, "lastSeenAt": None}] + ACCOUNTS["accounts"]}})

    do_GET = do_PUT = _handle


class PryntServerTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.httpd = HTTPServer(("127.0.0.1", 0), StubAPI)
        threading.Thread(target=cls.httpd.serve_forever, daemon=True).start()
        cls.base = f"http://127.0.0.1:{cls.httpd.server_address[1]}/"

    @classmethod
    def tearDownClass(cls):
        cls.httpd.shutdown()

    def client(self, key=SK):
        return PryntServer(secret_key=key, endpoint=self.base)

    def test_defaults_to_prynt_cloud(self):
        self.assertEqual(DEFAULT_ENDPOINT, "https://api.pryntid.com")
        self.assertEqual(PryntServer(secret_key=SK).endpoint, "https://api.pryntid.com")

    def test_rejects_public_key(self):
        with self.assertRaises(ValueError):
            PryntServer(secret_key="pk_live_x")

    def test_get_event_returns_accounts_on_device(self):
        ev = self.client().get_event("req_1")
        self.assertEqual(ev["accountsOnDevice"], ACCOUNTS)
        call = CALLS[-1]
        self.assertEqual((call["method"], call["path"], call["auth"]), ("GET", "/v1/events/req_1", f"Bearer {SK}"))

    def test_request_id_is_url_encoded(self):
        self.client().get_event("../admin?x=1")
        self.assertEqual(CALLS[-1]["path"], "/v1/events/..%2Fadmin%3Fx%3D1")

    def test_update_event_puts_linked_id(self):
        r = self.client().update_event("req_1", linked_id="user_2")
        call = CALLS[-1]
        self.assertEqual((call["method"], call["path"]), ("PUT", "/v1/events/req_1"))
        self.assertEqual(call["type"], "application/json")
        self.assertEqual(call["body"], {"linkedId": "user_2"})
        self.assertEqual(r["linkedId"], "user_2")
        self.assertEqual(r["accountsOnDevice"]["count"], 2)

    def test_update_event_validates_input(self):
        n = len(CALLS)
        with self.assertRaises(ValueError):
            self.client().update_event("req_1", linked_id="  ")
        with self.assertRaises(ValueError):
            self.client().update_event("", linked_id="u")
        self.assertEqual(len(CALLS), n)

    def test_api_errors(self):
        with self.assertRaises(PryntError) as cm:
            self.client().get_event("req_missing")
        self.assertEqual((cm.exception.status, cm.exception.code), (404, "not_found"))
        with self.assertRaises(PryntError) as cm:
            self.client("sk_test_wrong").update_event("req_1", linked_id="u")
        self.assertEqual((cm.exception.status, cm.exception.code), (401, "invalid_key"))

    def test_network_error(self):
        with self.assertRaises(PryntError) as cm:
            PryntServer(secret_key=SK, endpoint="http://127.0.0.1:1").get_event("req_1")
        self.assertEqual(cm.exception.code, "network_error")


if __name__ == "__main__":
    unittest.main()
