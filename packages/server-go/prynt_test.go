package prynt

import (
	"crypto/aes"
	"crypto/cipher"
	"crypto/hmac"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"testing"
)

// seal mirrors the server's core.sealing.seal (nonce||ct||tag, AES-256-GCM) for round-trip.
func seal(t *testing.T, key []byte, plaintext string) string {
	block, _ := aes.NewCipher(key)
	gcm, _ := cipher.NewGCM(block)
	nonce := make([]byte, gcm.NonceSize())
	rand.Read(nonce)
	ct := gcm.Seal(nil, nonce, []byte(plaintext), nil)
	return base64.StdEncoding.EncodeToString(append(nonce, ct...))
}

func TestUnsealRoundTrip(t *testing.T) {
	key := make([]byte, 32)
	rand.Read(key)
	keyB64 := base64.StdEncoding.EncodeToString(key)
	sealed := seal(t, key, `{"visitorId":"vst_abc","confidence":{"score":0.98,"level":"high"}}`)
	out, err := UnsealResult(sealed, keyB64)
	if err != nil {
		t.Fatalf("unseal: %v", err)
	}
	if out["visitorId"] != "vst_abc" {
		t.Fatalf("got %v", out["visitorId"])
	}
}

func TestUnsealWrongKeyFails(t *testing.T) {
	key := make([]byte, 32)
	rand.Read(key)
	sealed := seal(t, key, `{"a":1}`)
	wrong := base64.StdEncoding.EncodeToString(make([]byte, 32))
	if _, err := UnsealResult(sealed, wrong); err == nil {
		t.Fatal("expected failure with wrong key")
	}
}

func TestVerifyWebhook(t *testing.T) {
	secret, ts, body := "whsec", "9999999999", []byte(`{"type":"x"}`)
	mac := hmac.New(sha256.New, []byte(secret))
	mac.Write([]byte(ts + "."))
	mac.Write(body)
	sig := "sha256=" + hex.EncodeToString(mac.Sum(nil))
	if !VerifyWebhook(body, sig, ts, secret, 0) {
		t.Fatal("valid signature rejected")
	}
	if VerifyWebhook(body, "sha256=deadbeef", ts, secret, 0) {
		t.Fatal("bad signature accepted")
	}
}
