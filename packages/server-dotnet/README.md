# Prynt server SDK for .NET

Verify identifications, verify webhooks, and unseal Sealed Results. Uses only the BCL
(`System.Text.Json`, `System.Security.Cryptography`). Target net8.0+.

```bash
dotnet add package Prynt.Server
```

```csharp
using Prynt;

// Defaults to Prynt Cloud (https://api.pryntid.com). Self-hosted: new PryntServer(key, "https://your-prynt-server")
var prynt = new PryntServer(Environment.GetEnvironmentVariable("PRYNT_SECRET_KEY"));
JsonElement ev = await prynt.GetEventAsync(requestId);
bool bot = ev.GetProperty("smartSignals").GetProperty("bot").GetProperty("result").GetBoolean();

// Verify a webhook (pass the RAW body bytes)
bool ok = PryntServer.VerifyWebhook(rawBody, sigHeader, tsHeader, webhookSecret, 300);

// Unseal a Sealed Result on your server
JsonElement result = PryntServer.UnsealResult(sealedFromBrowser, Environment.GetEnvironmentVariable("PRYNT_SEALING_KEY"));
```

## Signup abuse: accounts on this device

The event includes `accountsOnDevice` — every one of your account ids (`linkedId`) ever seen on
the device: `{ "count": 2, "truncated": false, "accounts": [{ "linkedId": "user_123",
"events": 7, "firstSeenAt": "…", "lastSeenAt": "…" }] }` (at most 20 listed). After creating the
account, attach its id so the next signup from the same device sees it:

```csharp
JsonElement ev = await prynt.GetEventAsync(form.PryntRequestId);
if (ev.GetProperty("decision").GetString() == "block"
    || ev.GetProperty("accountsOnDevice").GetProperty("count").GetInt32() >= 1)
    return Results.Conflict("This device already has an account");

var user = await users.CreateAsync(form);
await prynt.UpdateEventAsync(form.PryntRequestId, user.Id.ToString());   // PUT /v1/events/:id
```

Errors throw `PryntException` (`Status`, `Code`).

MIT licensed.
