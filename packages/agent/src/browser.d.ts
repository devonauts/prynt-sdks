// Ambient typings for the non-standard / experimental browser surfaces the agent probes.
// Declaring them here lets every collector read real properties with real types — there is
// no `any` anywhere in the SDK. Standard APIs (Navigator.webdriver, Math.*, StorageManager,
// Permissions, OfflineAudioContext) already ship in lib.dom and are used directly.

interface UADataBrand {
  brand: string;
  version: string;
}

interface UAHighEntropyValues {
  architecture?: string;
  bitness?: string;
  model?: string;
  platformVersion?: string;
  uaFullVersion?: string;
  fullVersionList?: UADataBrand[];
  wow64?: boolean;
}

interface NavigatorUAData {
  readonly brands?: UADataBrand[];
  readonly mobile?: boolean;
  readonly platform?: string;
  getHighEntropyValues?(hints: string[]): Promise<UAHighEntropyValues>;
}

// window.chrome is present in real Chrome and subtly wrong/absent in headless builds.
interface ChromeRuntimeSurface {
  readonly runtime?: unknown;
}

interface Navigator {
  readonly userAgentData?: NavigatorUAData;
  readonly deviceMemory?: number;
  readonly globalPrivacyControl?: boolean;
  readonly msDoNotTrack?: string | null;
  readonly cpuClass?: string;
}

interface Window {
  readonly chrome?: ChromeRuntimeSurface;
  readonly doNotTrack?: string | null;
  readonly webkitOfflineAudioContext?: typeof OfflineAudioContext;
}
