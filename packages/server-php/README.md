# prynt/server — Prynt server SDK for PHP

Verify a browser identification from your backend with your **secret** key, verify webhook
signatures, and decrypt Sealed Results. Requires PHP 8.0+ with `curl`, `openssl`, `json`.

```bash
composer require prynt/server
```

```php
use Prynt\PryntServer;

$prynt = new PryntServer(getenv('PRYNT_SECRET_KEY'));
// The endpoint defaults to Prynt Cloud (https://api.pryntid.com); pass a second argument only
// when self-hosting: new PryntServer($key, 'https://your-prynt-server').

$event = $prynt->getEvent($requestId);
if (!empty($event['smartSignals']['bot']['result'])) {
    http_response_code(403);
    exit('bot');
}
```

### Signup abuse: accounts on this device

`getEvent()` includes `accountsOnDevice` — every one of your account ids (`linkedId`) ever seen
on the device: `['count' => 2, 'truncated' => false, 'accounts' => [['linkedId' => 'user_123',
'events' => 7, 'firstSeenAt' => '…', 'lastSeenAt' => '…'], …]]` (at most 20 listed). After
creating the account, attach its id with `updateEvent()` so the next signup from the same device
sees it:

```php
$event = $prynt->getEvent($_POST['pryntRequestId']);
if ($event['decision'] === 'block' || $event['accountsOnDevice']['count'] >= 1) {
    http_response_code(409);
    exit('This device already has an account');
}
$user = createUser($_POST);
$prynt->updateEvent($_POST['pryntRequestId'], (string) $user->id);
```

Errors throw `Prynt\PryntException` (`getCode()` = HTTP status, `$codeStr` = error code).

### Verify a webhook

```php
$ok = PryntServer::verifyWebhook(
    file_get_contents('php://input'),        // the RAW request body
    $_SERVER['HTTP_X_PRYNT_SIGNATURE'] ?? '',
    $_SERVER['HTTP_X_PRYNT_TIMESTAMP'] ?? '',
    $webhookSecret,
    300                                       // reject deliveries older than 5 min
);
```

### Unseal a Sealed Result

```php
$result = PryntServer::unsealResult($sealedResultFromBrowser, getenv('PRYNT_SEALING_KEY'));
// $result['visitorId'], $result['confidence'], $result['smartSignals'] …
```

The browser — and Prynt — never see the plaintext of a sealed result; only your server, holding
the sealing key, can open it. Provision the key in the console (Sealed Results → Rotate).

MIT licensed.
