require 'json'
package = JSON.parse(File.read(File.join(__dir__, 'package.json')))
Pod::Spec.new do |s|
  s.name         = 'prynt-react-native'
  s.version      = package['version']
  s.summary      = package['description']
  s.homepage     = package['homepage']
  s.license      = 'MIT'
  s.author       = 'Prynt'
  s.platform     = :ios, '13.0'
  s.source       = { :git => 'https://github.com/devonauts/prynt-sdks.git', :tag => "packages/mobile-react-native/v#{s.version}" }
  s.source_files = 'ios/**/*.{swift,m,h}'
  s.swift_version = '5.7'
  s.dependency 'React-Core'
  s.dependency 'Prynt', '~> 1.0'   # the native iOS SDK (CocoaPods trunk)
end
