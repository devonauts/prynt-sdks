# Prynt server SDK for Go

Verify a browser identification from your backend with your **secret** key, verify webhook
signatures, and decrypt Sealed Results. Never trust the browser's response body alone.

```bash
go get github.com/devonauts/prynt-sdks/packages/server-go
```

```go
import prynt "github.com/devonauts/prynt-sdks/packages/server-go"

client := prynt.New(prynt.Config{SecretKey: os.Getenv("PRYNT_SECRET_KEY")})
// Endpoint defaults to Prynt Cloud (https://api.pryntid.com); set it only when self-hosting.

event, err := client.GetEvent(ctx, requestID)
if err == nil && event.SmartSignals["bot"].Result {
    http.Error(w, "bot", http.StatusForbidden)
}
```

### Signup abuse: accounts on this device

`GetEvent` returns `AccountsOnDevice` — every one of your account ids (`linkedId`) ever seen on
the device (`Count`, `Truncated` when more than 20, `Accounts[]` with `LinkedID`, `Events`,
`FirstSeenAt`, `LastSeenAt`). After creating the account, attach its id with `UpdateEvent` so the
next signup from the same device sees it:

```go
event, err := client.GetEvent(ctx, form.PryntRequestID)
if err != nil { /* fail open or closed, your call */ }
if event.Decision == "block" || event.AccountsOnDevice.Count >= 1 {
    http.Error(w, "this device already has an account", http.StatusConflict)
    return
}
user := createUser(form)
_, err = client.UpdateEvent(ctx, form.PryntRequestID, strconv.Itoa(user.ID))
```

### Verify a webhook

```go
ok := prynt.VerifyWebhook(
    rawBody,                          // the RAW request body bytes
    r.Header.Get("X-Prynt-Signature"),
    r.Header.Get("X-Prynt-Timestamp"),
    webhookSecret,
    300,                              // reject deliveries older than 5 min (0 = no check)
)
```

### Unseal a Sealed Result

```go
result, err := prynt.UnsealResult(sealedResultFromBrowser, os.Getenv("PRYNT_SEALING_KEY"))
// result["visitorId"], result["confidence"], result["smartSignals"] …
```

The browser — and Prynt — never see the plaintext of a sealed result; only your server, holding
the sealing key, can open it. Provision the key in the console (Sealed Results → Rotate).

MIT licensed.
