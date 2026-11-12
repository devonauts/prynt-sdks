using System;
using System.Net.Http;
using System.Net.Http.Headers;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using System.Threading.Tasks;

namespace Prynt
{
    /// <summary>
    /// Prynt server SDK for .NET. Verify a browser identification from your backend with your
    /// SECRET key, verify webhook signatures, and unseal Sealed Results.
    ///
    /// <code>
    /// var prynt = new PryntServer(Environment.GetEnvironmentVariable("PRYNT_SECRET_KEY")); // Prynt Cloud
    /// JsonElement ev = await prynt.GetEventAsync(requestId);
    /// bool bot = ev.GetProperty("smartSignals").GetProperty("bot").GetProperty("result").GetBoolean();
    /// int accounts = ev.GetProperty("accountsOnDevice").GetProperty("count").GetInt32();
    /// await prynt.UpdateEventAsync(requestId, user.Id.ToString()); // after signup
    /// </code>
    /// </summary>
    public sealed class PryntServer
    {
        /// <summary>Prynt Cloud's API. Self-hosted installs pass their own base URL.</summary>
        public const string DefaultEndpoint = "https://api.pryntid.com";

        /// <summary>This SDK's version, sent as User-Agent / X-Prynt-SDK so Prynt can tell which SDKs an account runs.</summary>
        public const string Version = "1.0.0";

        private readonly string _secretKey;
        private readonly string _endpoint;
        private readonly HttpClient _http;

        public PryntServer(string secretKey, string endpoint = DefaultEndpoint, int timeoutSeconds = 5)
        {
            if (string.IsNullOrEmpty(secretKey) || !secretKey.StartsWith("sk_", StringComparison.Ordinal))
                throw new ArgumentException("[Prynt] secretKey must be set and start with sk_");
            _secretKey = secretKey;
            _endpoint = (string.IsNullOrEmpty(endpoint) ? DefaultEndpoint : endpoint).TrimEnd('/');
            _http = new HttpClient { Timeout = TimeSpan.FromSeconds(timeoutSeconds) };
        }

        /// <summary>
        /// Fetch the authoritative server-side record for a requestId. Includes
        /// <c>accountsOnDevice</c> = { count, truncated, accounts: [{ linkedId, events, firstSeenAt,
        /// lastSeenAt }] }: every one of your account ids seen on the device.
        /// </summary>
        public Task<JsonElement> GetEventAsync(string requestId)
        {
            return SendAsync(HttpMethod.Get, EventUrl(requestId), null);
        }

        /// <summary>
        /// Attach your account id to an identification after the fact — typically right after
        /// signup, when the browser identified before the user id existed. From then on the
        /// device's <c>accountsOnDevice</c> includes it. Returns { requestId, visitorId, linkedId,
        /// accountsOnDevice }.
        /// </summary>
        public Task<JsonElement> UpdateEventAsync(string requestId, string linkedId)
        {
            var url = EventUrl(requestId);
            if (string.IsNullOrWhiteSpace(linkedId))
                throw new ArgumentException("[Prynt] linkedId is required");
            var json = JsonSerializer.Serialize(new { linkedId });
            return SendAsync(HttpMethod.Put, url, new StringContent(json, Encoding.UTF8, "application/json"));
        }

        private string EventUrl(string requestId)
        {
            if (string.IsNullOrEmpty(requestId))
                throw new ArgumentException("[Prynt] requestId is required");
            return $"{_endpoint}/v1/events/{Uri.EscapeDataString(requestId)}";
        }

        private async Task<JsonElement> SendAsync(HttpMethod method, string url, HttpContent? content)
        {
            using var req = new HttpRequestMessage(method, url) { Content = content };
            req.Headers.Authorization = new AuthenticationHeaderValue("Bearer", _secretKey);
            req.Headers.TryAddWithoutValidation("User-Agent", "prynt-dotnet/" + Version);
            req.Headers.TryAddWithoutValidation("X-Prynt-SDK", "dotnet/" + Version);
            using var res = await _http.SendAsync(req).ConfigureAwait(false);
            var body = await res.Content.ReadAsStringAsync().ConfigureAwait(false);
            JsonDocument doc;
            try
            {
                doc = JsonDocument.Parse(string.IsNullOrWhiteSpace(body) ? "{}" : body);
            }
            catch (JsonException)
            {
                doc = JsonDocument.Parse("{}");
            }
            using (doc)
            {
                if ((int)res.StatusCode < 200 || (int)res.StatusCode >= 300)
                {
                    string code = "error", message = $"request failed ({(int)res.StatusCode})";
                    if (doc.RootElement.ValueKind == JsonValueKind.Object
                        && doc.RootElement.TryGetProperty("error", out var err)
                        && err.ValueKind == JsonValueKind.Object)
                    {
                        if (err.TryGetProperty("code", out var c)) code = c.GetString() ?? code;
                        if (err.TryGetProperty("message", out var m)) message = m.GetString() ?? message;
                    }
                    throw new PryntException(message, (int)res.StatusCode, code);
                }
                return doc.RootElement.Clone();
            }
        }

        /// <summary>
        /// Verify a Prynt webhook signature:
        ///   X-Prynt-Signature: sha256=&lt;hex HMAC_SHA256(secret, timestamp + "." + rawBody)&gt;
        /// Pass the RAW request body. toleranceSec &gt; 0 also rejects deliveries older than that.
        /// </summary>
        public static bool VerifyWebhook(byte[] rawBody, string signatureHeader, string timestamp,
                                         string secret, long toleranceSec = 300)
        {
            if (string.IsNullOrEmpty(signatureHeader) || string.IsNullOrEmpty(timestamp) || string.IsNullOrEmpty(secret))
                return false;
            var provided = signatureHeader.StartsWith("sha256=", StringComparison.Ordinal)
                ? signatureHeader.Substring(7) : signatureHeader;
            if (toleranceSec > 0)
            {
                if (!long.TryParse(timestamp, out var ts)) return false;
                var age = Math.Abs(DateTimeOffset.UtcNow.ToUnixTimeSeconds() - ts);
                if (age > toleranceSec) return false;
            }
            using var mac = new HMACSHA256(Encoding.UTF8.GetBytes(secret));
            var prefix = Encoding.UTF8.GetBytes(timestamp + ".");
            var msg = new byte[prefix.Length + rawBody.Length];
            Buffer.BlockCopy(prefix, 0, msg, 0, prefix.Length);
            Buffer.BlockCopy(rawBody, 0, msg, prefix.Length, rawBody.Length);
            var expected = ToHex(mac.ComputeHash(msg));
            return CryptographicOperations.FixedTimeEquals(
                Encoding.UTF8.GetBytes(expected), Encoding.UTF8.GetBytes(provided));
        }

        /// <summary>
        /// Decrypt a Sealed Result with your sealing key. Wire format:
        /// base64( nonce[12] || ciphertext || tag[16] ), AES-256-GCM.
        /// </summary>
        public static JsonElement UnsealResult(string sealed_, string sealingKeyBase64)
        {
            var key = Convert.FromBase64String(sealingKeyBase64);
            if (key.Length != 32) throw new PryntException("[Prynt] sealing key must decode to 32 bytes", 0, "bad_key");
            var blob = Convert.FromBase64String(sealed_);
            if (blob.Length < 12 + 16) throw new PryntException("[Prynt] malformed sealed result", 0, "bad_sealed");
            var nonce = new byte[12];
            var tag = new byte[16];
            var ct = new byte[blob.Length - 12 - 16];
            Buffer.BlockCopy(blob, 0, nonce, 0, 12);
            Buffer.BlockCopy(blob, blob.Length - 16, tag, 0, 16);
            Buffer.BlockCopy(blob, 12, ct, 0, ct.Length);
            var plaintext = new byte[ct.Length];
            try
            {
                using var gcm = new AesGcm(key, 16);
                gcm.Decrypt(nonce, ct, tag, plaintext);
            }
            catch (CryptographicException)
            {
                throw new PryntException("[Prynt] unseal failed (wrong key or tampered result)", 0, "unseal_failed");
            }
            using var doc = JsonDocument.Parse(plaintext);
            return doc.RootElement.Clone();
        }

        private static string ToHex(byte[] b)
        {
            var sb = new StringBuilder(b.Length * 2);
            foreach (var x in b) sb.Append(x.ToString("x2"));
            return sb.ToString();
        }
    }

    /// <summary>Raised on a non-2xx API response or an unseal failure.</summary>
    public sealed class PryntException : Exception
    {
        public int Status { get; }
        public string Code { get; }

        public PryntException(string message, int status, string code) : base(message)
        {
            Status = status;
            Code = code;
        }
    }
}
