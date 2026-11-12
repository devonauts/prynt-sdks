# frozen_string_literal: true

require_relative 'lib/prynt'

Gem::Specification.new do |s|
  s.name        = 'prynt'
  s.version     = Prynt::VERSION
  s.summary     = 'Prynt server SDK for Ruby'
  s.description = 'Verify Prynt identifications and webhooks, and unseal Sealed Results.'
  s.authors     = ['Prynt']
  s.homepage    = 'https://pryntid.com'
  s.license     = 'MIT'
  s.files       = ['lib/prynt.rb', 'README.md', 'LICENSE', 'CHANGELOG.md']
  s.require_paths = ['lib']
  s.required_ruby_version = '>= 2.6'
  s.metadata = {
    'source_code_uri' => 'https://github.com/devonauts/prynt-sdks/tree/main/packages/server-ruby',
    'bug_tracker_uri' => 'https://github.com/devonauts/prynt-sdks/issues',
    'changelog_uri' => 'https://github.com/devonauts/prynt-sdks/blob/main/packages/server-ruby/CHANGELOG.md',
    'homepage_uri' => 'https://pryntid.com',
  }
end
