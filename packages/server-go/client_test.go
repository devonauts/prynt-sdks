package prynt

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"testing"
)

const testKey = "sk_test_abc"

type call struct{ Method, Path, Auth, Type, Body string }

func stub(t *testing.T) (*httptest.Server, *[]call) {
	calls := &[]call{}
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		raw, _ := io.ReadAll(r.Body)
		*calls = append(*calls, call{r.Method, r.URL.EscapedPath(), r.Header.Get("Authorization"),
			r.Header.Get("Content-Type"), string(raw)})
		w.Header().Set("Content-Type", "application/json")
		if r.Header.Get("Authorization") != "Bearer "+testKey {
			w.WriteHeader(401)
			w.Write([]byte(`{"error":{"code":"invalid_key","message":"Unknown or disabled secret key"}}`))
			return
		}
		if r.URL.Path == "/v1/events/req_missing" {
			w.WriteHeader(404)
			w.Write([]byte(`{"error":{"code":"not_found","message":"No such requestId for this tenant"}}`))
			return
		}
		acc := `{"count":1,"truncated":false,"accounts":[{"linkedId":"user_1","events":3,"firstSeenAt":"2026-10-01T00:00:00Z","lastSeenAt":"2026-10-02T00:00:00Z"}]}`
		if r.Method == http.MethodGet {
			w.Write([]byte(`{"requestId":"req_1","visitorId":"vis_1","decision":"allow","riskScore":3,"smartSignals":{"bot":{"result":false}},"accountsOnDevice":` + acc + `}`))
			return
		}
		var b struct {
			LinkedID string `json:"linkedId"`
		}
		json.Unmarshal(raw, &b)
		w.Write([]byte(`{"requestId":"req_1","visitorId":"vis_1","linkedId":"` + b.LinkedID + `","accountsOnDevice":{"count":2,"truncated":false,"accounts":[]}}`))
	}))
	t.Cleanup(srv.Close)
	return srv, calls
}

func TestDefaultEndpoint(t *testing.T) {
	if c := New(Config{SecretKey: testKey}); c.endpoint != "https://api.pryntid.com" {
		t.Fatalf("default endpoint = %q", c.endpoint)
	}
}

func TestGetEventAccountsOnDevice(t *testing.T) {
	srv, calls := stub(t)
	ev, err := New(Config{SecretKey: testKey, Endpoint: srv.URL + "/"}).GetEvent(context.Background(), "req_1")
	if err != nil {
		t.Fatal(err)
	}
	if ev.Decision != "allow" || ev.RiskScore == nil || *ev.RiskScore != 3 {
		t.Fatalf("decision/riskScore not decoded: %+v", ev)
	}
	a := ev.AccountsOnDevice
	if a.Count != 1 || a.Truncated || len(a.Accounts) != 1 || a.Accounts[0].LinkedID != "user_1" || a.Accounts[0].Events != 3 {
		t.Fatalf("accountsOnDevice = %+v", a)
	}
	if c := (*calls)[0]; c.Method != "GET" || c.Path != "/v1/events/req_1" || c.Auth != "Bearer "+testKey {
		t.Fatalf("call = %+v", c)
	}
}

func TestRequestIDIsEscaped(t *testing.T) {
	srv, calls := stub(t)
	New(Config{SecretKey: testKey, Endpoint: srv.URL}).GetEvent(context.Background(), "../admin?x=1")
	if p := (*calls)[0].Path; p != "/v1/events/..%2Fadmin%3Fx=1" {
		t.Fatalf("path = %q", p)
	}
}

func TestUpdateEvent(t *testing.T) {
	srv, calls := stub(t)
	r, err := New(Config{SecretKey: testKey, Endpoint: srv.URL}).UpdateEvent(context.Background(), "req_1", "user_2")
	if err != nil {
		t.Fatal(err)
	}
	if r.LinkedID != "user_2" || r.AccountsOnDevice.Count != 2 {
		t.Fatalf("result = %+v", r)
	}
	c := (*calls)[0]
	if c.Method != "PUT" || c.Path != "/v1/events/req_1" || c.Type != "application/json" || c.Body != `{"linkedId":"user_2"}` {
		t.Fatalf("call = %+v", c)
	}
}

func TestUpdateEventValidates(t *testing.T) {
	srv, calls := stub(t)
	c := New(Config{SecretKey: testKey, Endpoint: srv.URL})
	if _, err := c.UpdateEvent(context.Background(), "req_1", "  "); err == nil {
		t.Fatal("empty linkedID accepted")
	}
	if len(*calls) != 0 {
		t.Fatal("API called with invalid input")
	}
}

func TestAPIError(t *testing.T) {
	srv, _ := stub(t)
	_, err := New(Config{SecretKey: testKey, Endpoint: srv.URL}).GetEvent(context.Background(), "req_missing")
	var apiErr *APIError
	if !errors.As(err, &apiErr) || apiErr.Status != 404 || apiErr.Code != "not_found" {
		t.Fatalf("err = %v", err)
	}
}
