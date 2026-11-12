// Package prynt is the Prynt server SDK for Go. Verify a browser identification from your
// backend with your SECRET key, verify webhook signatures, and unseal Sealed Results.
//
//	client := prynt.New(prynt.Config{SecretKey: os.Getenv("PRYNT_SECRET_KEY")})
//	event, err := client.GetEvent(ctx, requestId)
//	if err == nil && event.SmartSignals["bot"].Result { blockRequest() }
//	if err == nil && event.AccountsOnDevice.Count > 0 { reviewSignup() }   // multi-accounting
//	_, err = client.UpdateEvent(ctx, requestId, strconv.Itoa(user.ID))     // after signup
package prynt

import (
	"bytes"
	"context"
	"crypto/aes"
	"crypto/cipher"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"time"
)

// DefaultEndpoint is Prynt Cloud's API. Self-hosted installs set Config.Endpoint.
const DefaultEndpoint = "https://api.pryntid.com"

// Version is this SDK's version, sent as User-Agent / X-Prynt-SDK so Prynt can tell which SDKs an
// account runs.
const Version = "1.0.0"

// Config configures a Client. Only SecretKey is required.
type Config struct {
	SecretKey string
	Endpoint  string        // default DefaultEndpoint (https://api.pryntid.com)
	Timeout   time.Duration // default 5s
}

// Client talks to the Prynt server API.
type Client struct {
	secretKey string
	endpoint  string
	http      *http.Client
}

// Confidence is the calibrated match confidence.
type Confidence struct {
	Score float64 `json:"score"`
	Level string  `json:"level"`
}

// SmartSignal is one server-derived signal (bot, vpn, tor, datacenter, …).
type SmartSignal struct {
	Result bool                   `json:"result"`
	Extra  map[string]interface{} `json:"-"`
}

// Event is the authoritative server-side identification record.
type Event struct {
	RequestID    string                 `json:"requestId"`
	VisitorID    string                 `json:"visitorId"`
	VisitorFound bool                   `json:"visitorFound"`
	Environment  string                 `json:"environment"`
	Confidence   Confidence             `json:"confidence"`
	SmartSignals map[string]SmartSignal `json:"smartSignals"`
	IP           string                 `json:"ip,omitempty"`
	URL          string                 `json:"url,omitempty"`
	LinkedID     string                 `json:"linkedId,omitempty"`
	CreatedAt    string                 `json:"createdAt,omitempty"`
	// Decision is the verdict of your rules: "allow", "challenge" or "block".
	Decision  string `json:"decision,omitempty"`
	RiskScore *int   `json:"riskScore,omitempty"` // 0-100
	// AccountsOnDevice lists every linkedId (your own account id) seen on this device.
	AccountsOnDevice AccountsOnDevice `json:"accountsOnDevice"`
}

// AccountOnDevice is one of your accounts (a linkedId) seen on the device.
type AccountOnDevice struct {
	LinkedID    string `json:"linkedId"`
	Events      int    `json:"events"`
	FirstSeenAt string `json:"firstSeenAt,omitempty"`
	LastSeenAt  string `json:"lastSeenAt,omitempty"`
}

// AccountsOnDevice answers "does this device already have other accounts?" at signup.
type AccountsOnDevice struct {
	Count     int               `json:"count"`     // accounts listed (max 20)
	Truncated bool              `json:"truncated"` // more than 20 exist
	Accounts  []AccountOnDevice `json:"accounts"`  // newest first
}

// UpdateEventResult is the response of UpdateEvent.
type UpdateEventResult struct {
	RequestID        string           `json:"requestId"`
	VisitorID        string           `json:"visitorId"`
	LinkedID         string           `json:"linkedId"`
	AccountsOnDevice AccountsOnDevice `json:"accountsOnDevice"`
}

// APIError is a non-2xx response from the Prynt API.
type APIError struct {
	Status  int
	Code    string
	Message string
}

func (e *APIError) Error() string {
	return fmt.Sprintf("prynt: %s (%d %s)", e.Message, e.Status, e.Code)
}

// New creates a Client. It panics only on an obviously invalid secret key.
func New(cfg Config) *Client {
	if cfg.SecretKey == "" || !strings.HasPrefix(cfg.SecretKey, "sk_") {
		panic("prynt: SecretKey must be set and start with sk_")
	}
	endpoint := cfg.Endpoint
	if endpoint == "" {
		endpoint = DefaultEndpoint
	}
	timeout := cfg.Timeout
	if timeout == 0 {
		timeout = 5 * time.Second
	}
	return &Client{
		secretKey: cfg.SecretKey,
		endpoint:  strings.TrimRight(endpoint, "/"),
		http:      &http.Client{Timeout: timeout},
	}
}

func (c *Client) do(ctx context.Context, method, path string, payload interface{}, out interface{}) error {
	var body io.Reader
	if payload != nil {
		raw, err := json.Marshal(payload)
		if err != nil {
			return err
		}
		body = bytes.NewReader(raw)
	}
	req, err := http.NewRequestWithContext(ctx, method, c.endpoint+path, body)
	if err != nil {
		return err
	}
	req.Header.Set("Authorization", "Bearer "+c.secretKey)
	req.Header.Set("User-Agent", "prynt-go/"+Version)
	req.Header.Set("X-Prynt-SDK", "go/"+Version)
	if payload != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	res, err := c.http.Do(req)
	if err != nil {
		return err
	}
	defer res.Body.Close()
	resBody, _ := io.ReadAll(res.Body)
	if res.StatusCode < 200 || res.StatusCode >= 300 {
		var e struct {
			Error struct{ Code, Message string } `json:"error"`
		}
		_ = json.Unmarshal(resBody, &e)
		msg := e.Error.Message
		if msg == "" {
			msg = "request failed"
		}
		return &APIError{Status: res.StatusCode, Code: e.Error.Code, Message: msg}
	}
	return json.Unmarshal(resBody, out)
}

// GetEvent fetches the authoritative record for a requestId, including AccountsOnDevice.
func (c *Client) GetEvent(ctx context.Context, requestID string) (*Event, error) {
	if requestID == "" {
		return nil, fmt.Errorf("prynt: requestID is required")
	}
	var ev Event
	if err := c.do(ctx, http.MethodGet, "/v1/events/"+url.PathEscape(requestID), nil, &ev); err != nil {
		return nil, err
	}
	return &ev, nil
}

// UpdateEvent attaches your account id (linkedID) to an identification after the fact —
// typically right after signup, when the browser identified before the user id existed.
// From then on the device's AccountsOnDevice includes it.
func (c *Client) UpdateEvent(ctx context.Context, requestID, linkedID string) (*UpdateEventResult, error) {
	if requestID == "" {
		return nil, fmt.Errorf("prynt: requestID is required")
	}
	if strings.TrimSpace(linkedID) == "" {
		return nil, fmt.Errorf("prynt: linkedID is required")
	}
	var out UpdateEventResult
	err := c.do(ctx, http.MethodPut, "/v1/events/"+url.PathEscape(requestID),
		map[string]string{"linkedId": linkedID}, &out)
	if err != nil {
		return nil, err
	}
	return &out, nil
}

// IsBot is a convenience wrapper around GetEvent.
func (c *Client) IsBot(ctx context.Context, requestID string) (bool, error) {
	ev, err := c.GetEvent(ctx, requestID)
	if err != nil {
		return false, err
	}
	return ev.SmartSignals["bot"].Result, nil
}

// VerifyWebhook verifies a Prynt webhook signature:
//
//	X-Prynt-Signature: sha256=<hex HMAC_SHA256(secret, timestamp + "." + rawBody)>
//
// Pass the RAW request body. toleranceSec>0 also rejects deliveries older than that.
func VerifyWebhook(rawBody []byte, signatureHeader, timestamp, secret string, toleranceSec int64) bool {
	if signatureHeader == "" || timestamp == "" || secret == "" {
		return false
	}
	provided := strings.TrimPrefix(signatureHeader, "sha256=")
	if toleranceSec > 0 {
		ts, err := strconv.ParseInt(timestamp, 10, 64)
		if err != nil {
			return false
		}
		age := time.Now().Unix() - ts
		if age < 0 {
			age = -age
		}
		if age > toleranceSec {
			return false
		}
	}
	mac := hmac.New(sha256.New, []byte(secret))
	mac.Write([]byte(timestamp + "."))
	mac.Write(rawBody)
	expected := hex.EncodeToString(mac.Sum(nil))
	return hmac.Equal([]byte(expected), []byte(provided))
}

// UnsealResult decrypts a Sealed Result with your sealing key. Wire format:
// base64( nonce[12] || ciphertext || tag[16] ), AES-256-GCM.
func UnsealResult(sealed, keyBase64 string) (map[string]interface{}, error) {
	key, err := base64.StdEncoding.DecodeString(keyBase64)
	if err != nil || len(key) != 32 {
		return nil, fmt.Errorf("prynt: sealing key must decode to 32 bytes")
	}
	blob, err := base64.StdEncoding.DecodeString(sealed)
	if err != nil {
		return nil, fmt.Errorf("prynt: sealed result is not valid base64")
	}
	block, err := aes.NewCipher(key)
	if err != nil {
		return nil, err
	}
	gcm, err := cipher.NewGCM(block)
	if err != nil {
		return nil, err
	}
	ns := gcm.NonceSize()
	if len(blob) < ns+gcm.Overhead() {
		return nil, fmt.Errorf("prynt: malformed sealed result")
	}
	plaintext, err := gcm.Open(nil, blob[:ns], blob[ns:], nil)
	if err != nil {
		return nil, fmt.Errorf("prynt: unseal failed (wrong key or tampered result)")
	}
	var out map[string]interface{}
	if err := json.Unmarshal(plaintext, &out); err != nil {
		return nil, err
	}
	return out, nil
}
