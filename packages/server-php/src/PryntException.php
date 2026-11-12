<?php

declare(strict_types=1);

namespace Prynt;

/**
 * API, network or unseal error. getCode() is the HTTP status (0 when the API was unreachable);
 * $codeStr is the machine-readable error code (e.g. not_found, invalid_key, network_error).
 */
class PryntException extends \RuntimeException
{
    public string $codeStr;

    public function __construct(string $message, int $status, string $code)
    {
        parent::__construct($message, $status);
        $this->codeStr = $code;
    }
}
