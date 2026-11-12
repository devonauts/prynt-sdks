# frozen_string_literal: true

# Tests against a tiny local stub of the Prynt API (stdlib + minitest only):
#   ruby -Ilib test/test_prynt.rb
require 'minitest/autorun'
require 'socket'
require 'json'
require_relative '../lib/prynt'

class PryntServerTest < Minitest::Test
  KEY = 'sk_test_abc'
  ACCOUNTS = { 'count' => 1, 'truncated' => false,
               'accounts' => [{ 'linkedId' => 'user_1', 'events' => 3,
                                'firstSeenAt' => '2026-10-01T00:00:00Z', 'lastSeenAt' => '2026-10-02T00:00:00Z' }] }.freeze

  def setup
    @calls = []
    @server = TCPServer.new('127.0.0.1', 0)
    @thread = Thread.new { loop { serve(@server.accept) } }
    @base = "http://127.0.0.1:#{@server.addr[1]}/"
  end

  def teardown
    @thread.kill
    @server.close
  end

  def serve(sock)
    method, path = sock.gets.to_s.split(' ')
    headers = {}
    while (line = sock.gets) && line != "\r\n"
      k, v = line.split(':', 2)
      headers[k.downcase] = v.strip
    end
    raw = headers['content-length'] ? sock.read(headers['content-length'].to_i) : ''
    body = raw.empty? ? nil : JSON.parse(raw)
    @calls << { method: method, path: path, auth: headers['authorization'], type: headers['content-type'], body: body }
    status, out =
      if headers['authorization'] != "Bearer #{KEY}"
        [401, { 'error' => { 'code' => 'invalid_key', 'message' => 'Unknown or disabled secret key' } }]
      elsif path == '/v1/events/req_missing'
        [404, { 'error' => { 'code' => 'not_found', 'message' => 'No such requestId for this tenant' } }]
      elsif method == 'GET'
        [200, { 'requestId' => 'req_1', 'visitorId' => 'vis_1', 'decision' => 'allow',
                'smartSignals' => { 'bot' => { 'result' => false } }, 'accountsOnDevice' => ACCOUNTS }]
      else
        [200, { 'requestId' => 'req_1', 'visitorId' => 'vis_1', 'linkedId' => body['linkedId'],
                'accountsOnDevice' => { 'count' => 2, 'truncated' => false, 'accounts' => [] } }]
      end
    json = JSON.generate(out)
    sock.write("HTTP/1.1 #{status} X\r\nContent-Type: application/json\r\nContent-Length: #{json.bytesize}\r\nConnection: close\r\n\r\n#{json}")
    sock.close
  end

  def client(key = KEY)
    Prynt::Server.new(secret_key: key, endpoint: @base)
  end

  def test_defaults_to_prynt_cloud
    assert_equal 'https://api.pryntid.com', Prynt::DEFAULT_ENDPOINT
    assert_equal 'https://api.pryntid.com', Prynt::Server.new(secret_key: KEY).instance_variable_get(:@endpoint)
  end

  def test_get_event_returns_accounts_on_device
    ev = client.get_event('req_1')
    assert_equal ACCOUNTS, ev['accountsOnDevice']
    assert_equal({ method: 'GET', path: '/v1/events/req_1', auth: "Bearer #{KEY}", type: nil, body: nil }, @calls.last)
  end

  def test_request_id_is_escaped
    client.get_event('../a b?x=1')
    assert_equal '/v1/events/..%2Fa%20b%3Fx%3D1', @calls.last[:path]
  end

  def test_update_event_puts_linked_id
    r = client.update_event('req_1', linked_id: 'user_2')
    assert_equal 'user_2', r['linkedId']
    assert_equal 2, r['accountsOnDevice']['count']
    c = @calls.last
    assert_equal ['PUT', '/v1/events/req_1', 'application/json', { 'linkedId' => 'user_2' }],
                 [c[:method], c[:path], c[:type], c[:body]]
  end

  def test_update_event_validates_input
    assert_raises(ArgumentError) { client.update_event('req_1', linked_id: '  ') }
    assert_raises(ArgumentError) { client.update_event('', linked_id: 'u') }
    assert_empty @calls
  end

  def test_api_errors
    e = assert_raises(Prynt::Error) { client.get_event('req_missing') }
    assert_equal [404, 'not_found'], [e.status, e.code]
    e = assert_raises(Prynt::Error) { client('sk_test_wrong').update_event('req_1', linked_id: 'u') }
    assert_equal [401, 'invalid_key'], [e.status, e.code]
  end

  def test_network_error
    e = assert_raises(Prynt::Error) { Prynt::Server.new(secret_key: KEY, endpoint: 'http://127.0.0.1:1').get_event('x') }
    assert_equal 'network_error', e.code
  end
end
