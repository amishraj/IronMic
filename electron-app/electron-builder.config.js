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
    '!dist/mac-arm64',
    '!dist/mac',
    '!dist/win-unpacked',
    '!dist/linux-unpacked',
    'resources/**/*',
  ],
  asarUnpack: ['**/*.node'],
  extraResources: [
    {
      from: '../rust-core/ironmic-core.node',
      to: 'ironmic-core.node',
      filter: ['**/*'],
    },
    {
      from: `../rust-core/target/release/ironmic-llm${process.platform === 'win32' ? '.exe' : ''}`,
      to: `ironmic-llm${process.platform === 'win32' ? '.exe' : ''}`,
    },
    {
      from: '../rust-core/models/voices/',
      to: 'models/voices/',
      filter: ['*.bin'],
    },
    // TF.js ML models — tar.gz archives extracted on first launch
    {
      from: 'resources/ml-models/',
      to: 'ml-models/',
      filter: ['*.tar.gz'],
    },
    // BlackHole 2ch pkg for macOS system-audio capture (optional — if the file
    // is absent the app downloads it at runtime from the official GitHub release).
    // To bundle it: download BlackHole2ch.v0.6.0.pkg from
    //   https://github.com/ExistentialAudio/BlackHole/releases/tag/v0.6.0
    // and place it at electron-app/resources/blackhole/BlackHole2ch.v0.6.0.pkg
    // The glob filter means electron-builder silently skips this if no .pkg exists.
    {
      from: 'resources/blackhole/',
      to: 'blackhole/',
      filter: ['*.pkg'],
    },
  ],
  // electron-builder auto-converts icon.png to .icns (mac) and .ico (win)
  mac: {
    target: ['dmg'],
    category: 'public.app-category.productivity',
    icon: 'resources/icon.png',
    // Ad-hoc sign ('-') produces a valid local signature so Gatekeeper shows
    // "unidentified developer" (right-click → Open works) instead of
    // "damaged and can't be opened" on downloaded, unsigned DMGs.
    identity: '-',
    hardenedRuntime: true,
    gatekeeperAssess: false,
    entitlements: 'resources/entitlements.mac.plist',
    entitlementsInherit: 'resources/entitlements.mac.plist',
    extendInfo: {
      NSMicrophoneUsageDescription: 'IronMic needs microphone access for voice dictation.',
    },
  },
  dmg: {
    // Don't sign the DMG itself — ad-hoc app signing is what matters for Gatekeeper.
    sign: false,
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
