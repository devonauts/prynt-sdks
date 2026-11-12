import 'dart:async';
import 'package:flutter/rendering.dart';
import 'package:flutter/widgets.dart';
import 'package:flutter/services.dart';

/// Prynt Flutter plugin. Bridges to the native iOS/Android SDKs (device signals, integrity,
/// Keychain/Keystore id, attestation) and resolves identity server-side.
///
/// ```dart
/// final prynt = Prynt(apiKey: 'pk_live_…', endpoint: 'https://api.pryntid.com');
/// final result = await prynt.identify();
/// print('${result.visitorId} ${result.confidence.level}');
/// ```
class PryntConfidence {
  final double score;
  final String level;
  const PryntConfidence(this.score, this.level);
}

class PryntResult {
  final String requestId;
  final String visitorId;
  final bool visitorFound;
  final PryntConfidence confidence;
  final Map<String, dynamic> raw;
  const PryntResult(this.requestId, this.visitorId, this.visitorFound, this.confidence, this.raw);
}

class Prynt {
  static const MethodChannel _channel = MethodChannel('dev.prynt/sdk');

  final String apiKey;
  final String endpoint;
  Prynt({required this.apiKey, this.endpoint = 'https://api.pryntid.com'});

  Future<PryntResult> identify({Map<String, dynamic>? tag, String? linkedId}) async {
    final res = await _channel.invokeMapMethod<String, dynamic>('identify', <String, dynamic>{
      'apiKey': apiKey,
      'endpoint': endpoint,
      'tag': tag,
      'linkedId': linkedId,
    });
    final m = res ?? <String, dynamic>{};
    final c = (m['confidence'] as Map?)?.cast<String, dynamic>() ?? <String, dynamic>{};
    return PryntResult(
      m['requestId'] as String? ?? '',
      m['visitorId'] as String? ?? '',
      m['visitorFound'] as bool? ?? false,
      PryntConfidence((c['score'] as num? ?? 0).toDouble(), c['level'] as String? ?? 'low'),
      Map<String, dynamic>.from(m),
    );
  }
}


/// Prynt Replay for Flutter: the native recorders (iOS / Android) capture the app as low-rate screenshots, taps
/// become clicks. Flutter draws its own text fields, so this side reports where every [EditableText] and every
/// [PryntMask] is on screen (twice a second) and the native recorder paints over them **before** a frame leaves the
/// device.
///
/// ```dart
/// await PryntReplay.start(publicKey: 'pk_live_…', website: 'acme.com');
/// PryntReplay.identify('user_42');
/// PryntMask(child: Text(account.iban));   // anything else you want hidden
/// ```
class PryntReplay {
  static const MethodChannel _ch = MethodChannel('dev.prynt/sdk');
  static Timer? _masks;

  static Future<void> start({required String publicKey, required String website,
      String endpoint = 'https://api.pryntid.com', bool maskAllText = false, bool consent = true}) async {
    if (!publicKey.startsWith('pk_')) throw ArgumentError('publicKey must start with pk_');
    await _ch.invokeMethod('replayStart', {'publicKey': publicKey, 'website': website, 'endpoint': endpoint,
        'maskAllText': maskAllText, 'consent': consent});
    _masks?.cancel();
    _masks = Timer.periodic(const Duration(milliseconds: 500), (_) => _pushMasks());
  }

  static void identify(String userId) {
    if (userId.isEmpty || userId.contains('@')) return;
    _ch.invokeMethod('replayIdentify', {'userId': userId});
  }

  static void setConsent(bool given) => _ch.invokeMethod('replaySetConsent', {'given': given});

  static void stop() {
    _masks?.cancel();
    _ch.invokeMethod('replayStop');
  }

  static void _pushMasks() {
    final rects = <List<double>>[];
    void visit(Element e) {
      final w = e.widget;
      if (w is EditableText || w is PryntMask) {
        final ro = e.renderObject;
        if (ro is RenderBox && ro.attached && ro.hasSize) {
          final o = ro.localToGlobal(Offset.zero);
          rects.add([o.dx, o.dy, o.dx + ro.size.width, o.dy + ro.size.height]);
          return;
        }
      }
      e.visitChildElements(visit);
    }
    WidgetsBinding.instance.rootElement?.visitChildElements(visit);
    _ch.invokeMethod('replayMasks', {'rects': rects});
  }
}

/// Hides its child from Prynt Replay frames (painted over on the device).
class PryntMask extends StatelessWidget {
  const PryntMask({super.key, required this.child});
  final Widget child;
  @override
  Widget build(BuildContext context) => child;
}
