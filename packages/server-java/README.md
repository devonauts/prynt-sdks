# Prynt server SDK for Java

Zero-dependency (JDK 11+). Verify identifications, verify webhooks, and unseal Sealed Results.
JSON is returned as a raw string — parse it with your preferred library (Jackson, Gson, …).

```java
import com.prynt.PryntServer;

// Defaults to Prynt Cloud (https://api.pryntid.com). Self-hosted:
// new PryntServer(key, "https://your-prynt-server")
PryntServer prynt = new PryntServer(System.getenv("PRYNT_SECRET_KEY"));
String eventJson = prynt.getEvent(requestId);

// Verify a webhook (pass the RAW body bytes)
boolean ok = PryntServer.verifyWebhook(rawBody, sigHeader, tsHeader, webhookSecret, 300);

// Unseal a Sealed Result on your server
String resultJson = PryntServer.unsealResult(sealedFromBrowser, System.getenv("PRYNT_SEALING_KEY"));
```

## Signup abuse: accounts on this device

The event JSON includes `accountsOnDevice` — every one of your account ids (`linkedId`) ever seen
on the device: `{"count": 2, "truncated": false, "accounts": [{"linkedId": "user_123",
"events": 7, "firstSeenAt": "…", "lastSeenAt": "…"}]}` (at most 20 listed). Reject or review the
signup when `count` is above your limit; after creating the account, attach its id so the next
signup from the same device sees it:

```java
JsonNode event = mapper.readTree(prynt.getEvent(pryntRequestId));       // Jackson, for example
if ("block".equals(event.path("decision").asText())
        || event.path("accountsOnDevice").path("count").asInt() >= 1) {
    return ResponseEntity.status(409).build();
}
User user = users.create(form);
prynt.updateEvent(pryntRequestId, String.valueOf(user.getId()));        // PUT /v1/events/:id
```

Non-2xx responses throw `PryntServer.PryntException` (`status`, raw `body`).

## Install

Maven Central, `com.pryntid:prynt-server`:

```xml
<dependency>
  <groupId>com.pryntid</groupId>
  <artifactId>prynt-server</artifactId>
  <version>1.0.0</version>
</dependency>
```

Gradle: `implementation("com.pryntid:prynt-server:1.0.0")`. Build from source with `mvn -q package`.
MIT licensed.
