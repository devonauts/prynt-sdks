#import <React/RCTBridgeModule.h>

// Objective-C bridge exposing the Swift PryntBridge to React Native.
@interface RCT_EXTERN_MODULE(Prynt, NSObject)
RCT_EXTERN_METHOD(identify:(NSString *)apiKey
                  endpoint:(NSString *)endpoint
                  tag:(NSDictionary *)tag
                  linkedId:(NSString *)linkedId
                  resolver:(RCTPromiseResolveBlock)resolve
                  rejecter:(RCTPromiseRejectBlock)reject)
RCT_EXTERN_METHOD(replayStart:(NSString *)publicKey website:(NSString *)website endpoint:(NSString *)endpoint
                  maskAllText:(BOOL)maskAllText consent:(BOOL)consent)
RCT_EXTERN_METHOD(replayIdentify:(NSString *)userId)
RCT_EXTERN_METHOD(replaySetConsent:(BOOL)given)
RCT_EXTERN_METHOD(replayStop)
+ (BOOL)requiresMainQueueSetup { return NO; }
@end
