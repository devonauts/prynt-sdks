<?php

declare(strict_types=1);

namespace Prynt;

/**
 * Prynt server SDK for PHP. Verify a browser identification from your backend with your
 * SECRET key, verify webhook signatures, and unseal Sealed Results.
 *
 *   $prynt = new \Prynt\PryntServer(getenv('PRYNT_SECRET_KEY'));
 *   $event = $prynt->getEvent($requestId);
 *   if (!empty($event['smartSignals']['bot']['result'])) { blockRequest(); }
 *   if ($event['accountsOnDevice']['count'] > 0) { reviewSignup(); }   // multi-accounting
 *   $prynt->updateEvent($requestId, (string) $user->id);              // after signup
 */
final class PryntServer
{
    /** Prynt Cloud's API. Self-hosted installs pass their own base URL. */
    public const DEFAULT_ENDPOINT = 'https://api.pryntid.com';

    /** This SDK's version, sent as User-Agent / X-Prynt-SDK so Prynt can tell which SDKs an account runs. */
    public const VERSION = '1.0.0';

    private string $secretKey;
    private string $endpoint;
    private int $timeoutMs;

    public function __construct(string $secretKey, string $endpoint = self::DEFAULT_ENDPOINT, int $timeoutMs = 5000)
    {
        if ($secretKey === '' || !str_starts_with($secretKey, 'sk_')) {
            throw new \InvalidArgumentException('[Prynt] secretKey must be set and start with sk_');
        }
        $this->secretKey = $secretKey;
        $this->endpoint = rtrim($endpoint !== '' ? $endpoint : self::DEFAULT_ENDPOINT, '/');
        $this->timeoutMs = $timeoutMs;
    }

    /**
     * Fetch the authoritative server-side record for a requestId. Includes
     * `accountsOnDevice` = ['count' => int, 'truncated' => bool, 'accounts' => [['linkedId',
     * 'events', 'firstSeenAt', 'lastSeenAt'], ...]]: every one of your account ids seen on the device.
     *
     * @return array<string,mixed>
     * @throws PryntException
     */
    public function getEvent(string $requestId): array
    {
        if ($requestId === '') {
            throw new \InvalidArgumentException('[Prynt] requestId is required');
        }
        return $this->request('GET', '/v1/events/' . rawurlencode($requestId));
    }

    /**
     * Attach your account id to an identification after the fact — typically right after
     * signup, when the browser identified before the user id existed. From then on the
     * device's `accountsOnDevice` includes it.
     *
     * @return array<string,mixed> ['requestId', 'visitorId', 'linkedId', 'accountsOnDevice']
     * @throws PryntException
     */
    public function updateEvent(string $requestId, string $linkedId): array
    {
        if ($requestId === '') {
            throw new \InvalidArgumentException('[Prynt] requestId is required');
        }
        if (trim($linkedId) === '') {
            throw new \InvalidArgumentException('[Prynt] linkedId is required');
        }
        return $this->request('PUT', '/v1/events/' . rawurlencode($requestId), ['linkedId' => $linkedId]);
    }

    /**
     * @param array<string,mixed>|null $payload
     * @return array<string,mixed>
     * @throws PryntException
     */
    private function request(string $method, string $path, ?array $payload = null): array
    {
        $headers = ['Authorization: Bearer ' . $this->secretKey, 'Accept: application/json',
            'User-Agent: prynt-php/' . self::VERSION, 'X-Prynt-SDK: php/' . self::VERSION];
        $ch = curl_init($this->endpoint . $path);
        $opts = [
            CURLOPT_RETURNTRANSFER => true,
            CURLOPT_TIMEOUT_MS => $this->timeoutMs,
            CURLOPT_CUSTOMREQUEST => $method,
        ];
        if ($payload !== null) {
            $opts[CURLOPT_POSTFIELDS] = json_encode($payload);
            $headers[] = 'Content-Type: application/json';
        }
        $opts[CURLOPT_HTTPHEADER] = $headers;
        curl_setopt_array($ch, $opts);
        $raw = curl_exec($ch);
        if ($raw === false) {
            $err = curl_error($ch);
            curl_close($ch);
            throw new PryntException("[Prynt] request failed: $err", 0, 'network_error');
        }
        $status = (int) curl_getinfo($ch, CURLINFO_HTTP_CODE);
        curl_close($ch);
        $body = json_decode((string) $raw, true) ?: [];
        if ($status < 200 || $status >= 300) {
            $e = $body['error'] ?? [];
            throw new PryntException($e['message'] ?? "request failed ($status)", $status, $e['code'] ?? 'error');
        }
        return $body;
    }

    /** Convenience: true when the identification was flagged as a bot. */
    public function isBot(string $requestId): bool
    {
        return !empty($this->getEvent($requestId)['smartSignals']['bot']['result']);
    }

    /**
     * Verify a Prynt webhook signature:
     *   X-Prynt-Signature: sha256=<hex HMAC_SHA256(secret, timestamp . "." . rawBody)>
     * Pass the RAW request body. $toleranceSec>0 also rejects deliveries older than that.
     */
    public static function verifyWebhook(
        string $rawBody,
        string $signatureHeader,
        string $timestamp,
        string $secret,
        int $toleranceSec = 300
    ): bool {
        if ($signatureHeader === '' || $timestamp === '' || $secret === '') {
            return false;
        }
        $provided = str_starts_with($signatureHeader, 'sha256=') ? substr($signatureHeader, 7) : $signatureHeader;
        if ($toleranceSec > 0) {
            $age = abs(time() - (int) $timestamp);
            if ($age > $toleranceSec) {
                return false;
            }
        }
        $expected = hash_hmac('sha256', $timestamp . '.' . $rawBody, $secret);
        return hash_equals($expected, $provided);
    }

    /**
     * Decrypt a Sealed Result with your sealing key. Wire format:
     * base64( nonce[12] . ciphertext . tag[16] ), AES-256-GCM.
     *
     * @return array<string,mixed>
     * @throws PryntException
     */
    public static function unsealResult(string $sealed, string $sealingKeyBase64): array
    {
        $key = base64_decode($sealingKeyBase64, true);
        if ($key === false || strlen($key) !== 32) {
            throw new PryntException('[Prynt] sealing key must decode to 32 bytes', 0, 'bad_key');
        }
        $blob = base64_decode($sealed, true);
        if ($blob === false || strlen($blob) < 12 + 16) {
            throw new PryntException('[Prynt] malformed sealed result', 0, 'bad_sealed');
        }
        $nonce = substr($blob, 0, 12);
        $tag = substr($blob, -16);
        $ciphertext = substr($blob, 12, strlen($blob) - 12 - 16);
        $plaintext = openssl_decrypt($ciphertext, 'aes-256-gcm', $key, OPENSSL_RAW_DATA, $nonce, $tag);
        if ($plaintext === false) {
            throw new PryntException('[Prynt] unseal failed (wrong key or tampered result)', 0, 'unseal_failed');
        }
        return json_decode($plaintext, true) ?: [];
    }
}
