# Prynt server SDK for Ruby

Verify identifications, verify webhooks, and unseal Sealed Results. Standard library only.

```bash
gem install prynt
```

```ruby
require 'prynt'

prynt = Prynt::Server.new(secret_key: ENV['PRYNT_SECRET_KEY'])
# endpoint: defaults to Prynt Cloud (https://api.pryntid.com); pass it only when self-hosting.
event = prynt.get_event(request_id)          # Hash
block! if event.dig('smartSignals', 'bot', 'result')

# Verify a webhook (pass the RAW body)
ok = Prynt.verify_webhook(raw_body, sig_header, ts_header, webhook_secret)

# Unseal a Sealed Result on your server
result = Prynt.unseal_result(sealed_from_browser, ENV['PRYNT_SEALING_KEY'])   # Hash
```

## Signup abuse: accounts on this device

`get_event` includes `'accountsOnDevice'` — every one of your account ids (`linkedId`) ever seen
on the device: `{ 'count' => 2, 'truncated' => false, 'accounts' => [{ 'linkedId' => 'user_123',
'events' => 7, 'firstSeenAt' => '…', 'lastSeenAt' => '…' }, …] }` (at most 20 listed). After
creating the account, attach its id with `update_event` so the next signup from the same device
sees it:

```ruby
event = prynt.get_event(params[:prynt_request_id])
if event['decision'] == 'block' || event.dig('accountsOnDevice', 'count').to_i >= 1
  return head(:conflict)   # e.g. one free trial per device
end
user = User.create!(signup_params)
prynt.update_event(params[:prynt_request_id], linked_id: user.id.to_s)
```

Errors raise `Prynt::Error` with `#status` (HTTP status, 0 if unreachable) and `#code`.

Tests: `ruby -Ilib test/test_prynt.rb`

MIT licensed.
