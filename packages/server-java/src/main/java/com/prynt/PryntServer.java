package com.prynt;

import java.net.URI;
import java.net.URLEncoder;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.time.Duration;
import java.util.Arrays;
import java.util.Base64;
import javax.crypto.Cipher;
import javax.crypto.Mac;
import javax.crypto.spec.GCMParameterSpec;
import javax.crypto.spec.SecretKeySpec;

/**
 * Prynt server SDK for Java (zero external dependencies — pure JDK 11+). Verify a browser
 * identification from your backend with your SECRET key, verify webhook signatures, and unseal
 * Sealed Results. JSON is returned as a raw string; parse it with your JSON library of choice.
 *
 * <pre>
 *   PryntServer prynt = new PryntServer(System.getenv("PRYNT_SECRET_KEY")); // Prynt Cloud
 *   String eventJson = prynt.getEvent(requestId);           // authoritative record (raw JSON),
 *                                                           // incl. "accountsOnDevice"
 *   prynt.updateEvent(requestId, String.valueOf(user.id));  // after signup: attach the account
 *   String result    = PryntServer.unsealResult(sealed, key); // decrypted result (raw JSON)
 * </pre>
 */
public final class PryntServer {

    /** Prynt Cloud's API. Self-hosted installs pass their own base URL. */
    public static final String DEFAULT_ENDPOINT = "https://api.pryntid.com";

    /** This SDK's version, sent as User-Agent / X-Prynt-SDK so Prynt can tell which SDKs an account runs. */
    public static final String VERSION = "1.0.0";

    private final String secretKey;
    private final String endpoint;
    private final Duration timeout;
    private final HttpClient http;

    public PryntServer(String secretKey) {
        this(secretKey, DEFAULT_ENDPOINT, Duration.ofSeconds(5));
    }

    public PryntServer(String secretKey, String endpoint) {
        this(secretKey, endpoint, Duration.ofSeconds(5));
    }

    public PryntServer(String secretKey, String endpoint, Duration timeout) {
        if (secretKey == null || !secretKey.startsWith("sk_")) {
            throw new IllegalArgumentException("[Prynt] secretKey must be set and start with sk_");
        }
        this.secretKey = secretKey;
        this.endpoint = (endpoint == null || endpoint.isEmpty() ? DEFAULT_ENDPOINT : endpoint).replaceAll("/+$", "");
        this.timeout = timeout;
        this.http = HttpClient.newBuilder().connectTimeout(timeout).build();
    }

    /**
     * Fetch the authoritative server-side record for a requestId. Returns the raw JSON body,
     * which includes {@code "accountsOnDevice": {"count", "truncated", "accounts": [{"linkedId",
     * "events", "firstSeenAt", "lastSeenAt"}]}} — every one of your account ids seen on the device.
     */
    public String getEvent(String requestId) throws Exception {
        HttpRequest req = HttpRequest.newBuilder(eventUri(requestId))
                .header("Authorization", "Bearer " + secretKey)
                .header("User-Agent", "prynt-java/" + VERSION)
                .header("X-Prynt-SDK", "java/" + VERSION)
                .timeout(timeout)
                .GET().build();
        return send(req);
    }

    /**
     * Attach your account id to an identification after the fact — typically right after signup,
     * when the browser identified before the user id existed. From then on the device's
     * accountsOnDevice includes it. Returns the raw JSON body
     * ({@code requestId, visitorId, linkedId, accountsOnDevice}).
     */
    public String updateEvent(String requestId, String linkedId) throws Exception {
        URI uri = eventUri(requestId);
        if (linkedId == null || linkedId.trim().isEmpty()) {
            throw new IllegalArgumentException("[Prynt] linkedId is required");
        }
        HttpRequest req = HttpRequest.newBuilder(uri)
                .header("Authorization", "Bearer " + secretKey)
                .header("User-Agent", "prynt-java/" + VERSION)
                .header("X-Prynt-SDK", "java/" + VERSION)
                .header("Content-Type", "application/json")
                .timeout(timeout)
                .PUT(HttpRequest.BodyPublishers.ofString("{\"linkedId\":" + jsonString(linkedId) + "}"))
                .build();
        return send(req);
    }

    private URI eventUri(String requestId) {
        if (requestId == null || requestId.isEmpty()) {
            throw new IllegalArgumentException("[Prynt] requestId is required");
        }
        // URLEncoder is form encoding (' ' -> '+'); a path segment needs %20.
        String seg = URLEncoder.encode(requestId, StandardCharsets.UTF_8).replace("+", "%20");
        return URI.create(endpoint + "/v1/events/" + seg);
    }

    private String send(HttpRequest req) throws Exception {
        HttpResponse<String> res = http.send(req, HttpResponse.BodyHandlers.ofString());
        if (res.statusCode() < 200 || res.statusCode() >= 300) {
            throw new PryntException("[Prynt] request failed (" + res.statusCode() + ")",
                    res.statusCode(), res.body());
        }
        return res.body();
    }

    private static String jsonString(String s) {
        StringBuilder sb = new StringBuilder(s.length() + 2).append('"');
        for (int i = 0; i < s.length(); i++) {
            char c = s.charAt(i);
            switch (c) {
                case '"': sb.append("\\\""); break;
                case '\\': sb.append("\\\\"); break;
                case '\n': sb.append("\\n"); break;
                case '\r': sb.append("\\r"); break;
                case '\t': sb.append("\\t"); break;
                default:
                    if (c < 0x20) sb.append(String.format("\\u%04x", (int) c));
                    else sb.append(c);
            }
        }
        return sb.append('"').toString();
    }

    /**
     * Verify a Prynt webhook signature:
     *   X-Prynt-Signature: sha256=&lt;hex HMAC_SHA256(secret, timestamp + "." + rawBody)&gt;
     * Pass the RAW request body. toleranceSec &gt; 0 also rejects deliveries older than that.
     */
    public static boolean verifyWebhook(byte[] rawBody, String signatureHeader, String timestamp,
                                        String secret, long toleranceSec) {
        if (signatureHeader == null || timestamp == null || secret == null
                || signatureHeader.isEmpty() || timestamp.isEmpty() || secret.isEmpty()) {
            return false;
        }
        String provided = signatureHeader.startsWith("sha256=") ? signatureHeader.substring(7) : signatureHeader;
        if (toleranceSec > 0) {
            try {
                long age = Math.abs(System.currentTimeMillis() / 1000L - Long.parseLong(timestamp));
                if (age > toleranceSec) return false;
            } catch (NumberFormatException e) {
                return false;
            }
        }
        try {
            Mac mac = Mac.getInstance("HmacSHA256");
            mac.init(new SecretKeySpec(secret.getBytes(StandardCharsets.UTF_8), "HmacSHA256"));
            mac.update((timestamp + ".").getBytes(StandardCharsets.UTF_8));
            mac.update(rawBody);
            String expected = toHex(mac.doFinal());
            return MessageDigest.isEqual(expected.getBytes(StandardCharsets.UTF_8),
                    provided.getBytes(StandardCharsets.UTF_8));
        } catch (Exception e) {
            return false;
        }
    }

    /**
     * Decrypt a Sealed Result with your sealing key. Wire format:
     * base64( nonce[12] || ciphertext || tag[16] ), AES-256-GCM. Returns the raw JSON string.
     */
    public static String unsealResult(String sealed, String sealingKeyBase64) {
        byte[] key = Base64.getDecoder().decode(sealingKeyBase64);
        if (key.length != 32) {
            throw new PryntException("[Prynt] sealing key must decode to 32 bytes", 0, null);
        }
        byte[] blob = Base64.getDecoder().decode(sealed);
        if (blob.length < 12 + 16) {
            throw new PryntException("[Prynt] malformed sealed result", 0, null);
        }
        try {
            byte[] nonce = Arrays.copyOfRange(blob, 0, 12);
            byte[] ctAndTag = Arrays.copyOfRange(blob, 12, blob.length); // Java expects ct||tag together
            Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding");
            cipher.init(Cipher.DECRYPT_MODE, new SecretKeySpec(key, "AES"),
                    new GCMParameterSpec(128, nonce));
            return new String(cipher.doFinal(ctAndTag), StandardCharsets.UTF_8);
        } catch (Exception e) {
            throw new PryntException("[Prynt] unseal failed (wrong key or tampered result)", 0, null);
        }
    }

    private static String toHex(byte[] b) {
        StringBuilder sb = new StringBuilder(b.length * 2);
        for (byte x : b) sb.append(Character.forDigit((x >> 4) & 0xF, 16)).append(Character.forDigit(x & 0xF, 16));
        return sb.toString();
    }

    /** Raised on a non-2xx API response or an unseal failure. */
    public static final class PryntException extends RuntimeException {
        public final int status;
        public final String body;

        public PryntException(String message, int status, String body) {
            super(message);
            this.status = status;
            this.body = body;
        }
    }
}
