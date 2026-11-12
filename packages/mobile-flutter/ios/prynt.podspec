Pod::Spec.new do |s|
  s.name             = 'prynt'
  s.version          = '1.0.0'
  s.summary          = 'Prynt Flutter plugin (iOS)'
  s.homepage         = 'https://pryntid.com'
  s.license          = { :type => 'MIT' }
  s.author           = 'Prynt'
  s.source           = { :path => '.' }
  s.source_files     = 'Classes/**/*'
  s.dependency 'Flutter'
  s.dependency 'Prynt', '~> 1.0'   # the native iOS SDK (CocoaPods trunk)
  s.platform = :ios, '13.0'
  s.swift_version = '5.7'
end
