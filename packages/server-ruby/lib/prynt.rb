# frozen_string_literal: true

require 'net/http'
require 'json'
require 'openssl'
require 'base64'
require 'uri'

# Prynt server SDK for Ruby. Verify a browser identification from your backend with your
# SECRET key, verify webhook signatures, and unseal Sealed Results.
#
#   prynt = Prynt::Server.new(secret_key: ENV['PRYNT_SECRET_KEY'])
#   event = prynt.get_event(request_id)
#   block! if event.dig('smartSignals', 'bot', 'result')
#   review! if event.dig('accountsOnDevice', 'count').to_i.positive?   # multi-accounting
#   prynt.update_event(request_id, linked_id: user.id.to_s)            # after signup
module Prynt
  VERSION = '1.0.0'
  # Prynt Cloud's API. Self-hosted installs pass endpoint: 'https://your-prynt-server'.
  DEFAULT_ENDPOINT = 'https://api.pryntid.com'

  class Error < StandardError
    attr_reader :status, :code

    def initialize(message, status = 0, code = 'error')
      super(message)
      @status = status
      @code = code
    end
  end

  # Client for the authenticated Prynt server API.
  class Server
    def initialize(secret_key:, endpoint: DEFAULT_ENDPOINT, timeout: 5)
      raise ArgumentError, '[Prynt] secret_key must start with sk_' unless secret_key.to_s.start_with?('sk_')

      @secret_key = secret_key
      @endpoint = (endpoint.to_s.empty? ? DEFAULT_ENDPOINT : endpoint.to_s).sub(%r{/+\z}, '')
      @timeout = timeout
    end

    # Fetch the authoritative server-side record for a requestId. Returns a Hash, including
    # 'accountsOnDevice' => { 'count', 'truncated', 'accounts' => [{ 'linkedId', 'events',
    # 'firstSeenAt', 'lastSeenAt' }] }: every one of your account ids seen on the device.
    def get_event(request_id)
      request(Net::HTTP::Get, event_path(request_id))
    end

    # Attach your account id to an identification after the fact — typically right after
    # signup, when the browser identified before the user id existed. From then on the
    # device's accountsOnDevice includes it. Returns a Hash with 'requestId', 'visitorId',
    # 'linkedId' and 'accountsOnDevice'.
    def update_event(request_id, linked_id:)
      path = event_path(request_id)
      raise ArgumentError, '[Prynt] linked_id is required' if linked_id.to_s.strip.empty?

      request(Net::HTTP::Put, path, 'linkedId' => linked_id.to_s)
    end

    # Convenience: true when the identification was flagged as a bot.
    def bot?(request_id)
      !!get_event(request_id).dig('smartSignals', 'bot', 'result')
    end

    private

    def event_path(request_id)
      raise ArgumentError, '[Prynt] request_id is required' if request_id.to_s.empty?

      # Percent-encode for a path segment (encode_www_form_component would turn ' ' into '+').
      "/v1/events/#{URI.encode_www_form_component(request_id.to_s).gsub('+', '%20')}"
    end

    def request(klass, path, payload = nil)
      uri = URI("#{@endpoint}#{path}")
      http = Net::HTTP.new(uri.host, uri.port)
      http.use_ssl = uri.scheme == 'https'
      http.read_timeout = @timeout
      http.open_timeout = @timeout
      req = klass.new(uri)
      req['Authorization'] = "Bearer #{@secret_key}"
      req['Accept'] = 'application/json'
      req['User-Agent'] = "prynt-ruby/#{VERSION}"
      req['X-Prynt-SDK'] = "ruby/#{VERSION}"
      if payload
        req['Content-Type'] = 'application/json'
        req.body = JSON.generate(payload)
      end
      begin
        res = http.request(req)
      rescue Net::OpenTimeout, Net::ReadTimeout => e
        raise Error.new("[Prynt] request timed out: #{e.message}", 0, 'timeout')
      rescue SystemCallError, SocketError, IOError, OpenSSL::SSL::SSLError => e
        raise Error.new("[Prynt] request failed: #{e.message}", 0, 'network_error')
      end
      body = begin
        JSON.parse(res.body.to_s)
      rescue JSON::ParserError
        {}
      end
      unless (200..299).cover?(res.code.to_i)
        err = body.is_a?(Hash) ? (body['error'] || {}) : {}
        raise Error.new(err['message'] || "request failed (#{res.code})", res.code.to_i, err['code'] || 'error')
      end
      body
    end
  end

  # Verify a Prynt webhook signature:
  #   X-Prynt-Signature: sha256=<hex HMAC_SHA256(secret, "#{timestamp}.#{raw_body}")>
  # Pass the RAW request body. tolerance_sec > 0 also rejects deliveries older than that.
  def self.verify_webhook(raw_body, signature_header, timestamp, secret, tolerance_sec: 300)
    return false if signature_header.to_s.empty? || timestamp.to_s.empty? || secret.to_s.empty?

    provided = signature_header.sub(/\Asha256=/, '')
    return false if tolerance_sec.positive? && (Time.now.to_i - timestamp.to_i).abs > tolerance_sec

    expected = OpenSSL::HMAC.hexdigest('SHA256', secret, "#{timestamp}.#{raw_body}")
    secure_compare(expected, provided)
  end

  # Decrypt a Sealed Result with your sealing key. Wire format:
  #   base64( nonce[12] + ciphertext + tag[16] ), AES-256-GCM. Returns a Hash.
  def self.unseal_result(sealed, sealing_key_base64)
    key = Base64.decode64(sealing_key_base64)
    raise Error.new('[Prynt] sealing key must decode to 32 bytes', 0, 'bad_key') unless key.bytesize == 32

    blob = Base64.decode64(sealed)
    raise Error.new('[Prynt] malformed sealed result', 0, 'bad_sealed') if blob.bytesize < 12 + 16

    nonce = blob[0, 12]
    tag = blob[-16, 16]
    ciphertext = blob[12...-16]
    cipher = OpenSSL::Cipher.new('aes-256-gcm')
    cipher.decrypt
    cipher.key = key
    cipher.iv = nonce
    cipher.auth_tag = tag
    plaintext = cipher.update(ciphertext) + cipher.final
    JSON.parse(plaintext)
  rescue OpenSSL::Cipher::CipherError
    raise Error.new('[Prynt] unseal failed (wrong key or tampered result)', 0, 'unseal_failed')
  end

  # Constant-time string comparison.
  def self.secure_compare(a, b)
    return false unless a.bytesize == b.bytesize

    res = 0
    a.bytes.zip(b.bytes) { |x, y| res |= (x ^ y) }
    res.zero?
  end
  private_class_method :secure_compare
end
