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
      filter: ['**/*'],
    },
    {
      from: '../rust-core/models/',
      to: 'models/',
      filter: ['*.bin', '*.gguf', '*.onnx', 'voices/*.bin'],
    },
  ],
  // electron-builder auto-converts icon.png to .icns (mac) and .ico (win)
  mac: {
    target: ['dmg'],
    category: 'public.app-category.productivity',
    icon: 'resources/icon.png',
    identity: null,
    extendInfo: {
      NSMicrophoneUsageDescription: 'IronMic needs microphone access for voice dictation.',
    },
  },
  win: {
    target: ['nsis'],
    icon: 'resources/icon.png',
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
