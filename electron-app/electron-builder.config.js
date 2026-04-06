/**
 * Electron Builder configuration for IronMic.
 * Packages the app for macOS, Windows, and Linux.
 */
module.exports = {
  appId: 'com.ironmic.app',
  productName: 'IronMic',
  directories: {
    buildResources: 'resources',
    output: 'release',
  },
  files: [
    'dist/**/*',
    'resources/**/*',
  ],
  extraResources: [
    {
      from: '../rust-core/ironmic-core.node',
      to: 'ironmic-core.node',
    },
    {
      from: '../rust-core/models/',
      to: 'models/',
      filter: ['*.bin', '*.gguf'],
    },
  ],
  mac: {
    target: ['dmg'],
    category: 'public.app-category.productivity',
    icon: 'resources/icon.icns',
    hardenedRuntime: true,
    gatekeeperAssess: false,
    entitlements: 'resources/entitlements.mac.plist',
    entitlementsInherit: 'resources/entitlements.mac.plist',
    extendInfo: {
      NSMicrophoneUsageDescription: 'IronMic needs microphone access for voice dictation.',
    },
  },
  win: {
    target: ['nsis'],
    icon: 'resources/icon.ico',
  },
  nsis: {
    oneClick: false,
    perMachine: false,
    allowToChangeInstallationDirectory: true,
    deleteAppDataOnUninstall: false,
  },
  linux: {
    target: ['AppImage', 'deb'],
    icon: 'resources/icon.png',
    category: 'Utility',
  },
};
