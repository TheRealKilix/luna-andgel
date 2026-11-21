'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const webDir = path.join(root, 'www');
fs.mkdirSync(webDir, { recursive: true });

const page = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
const headAssets = [
  '<meta name="relay-endpoint" content="/api/ws">',
  '<link rel="manifest" href="/manifest.webmanifest">',
  '<link rel="icon" href="/app-icon.svg" type="image/svg+xml">',
  '<link rel="stylesheet" href="/app-icons.css">',
  '<script defer src="/update-config.js"></script>',
  '<script defer src="/pwa.js"></script>'
].join('');
fs.writeFileSync(
  path.join(webDir, 'index.html'),
  page.replace('</head>', `${headAssets}</head>`)
);

for (const file of ['manifest.webmanifest', 'app-icon.svg', 'app-icons.css', 'pwa.js', 'enhancements.js', 'sw.js']) {
  fs.copyFileSync(path.join(root, file), path.join(webDir, file));
}

const repository = process.env.LUNA_GITHUB_REPO || process.env.GITHUB_REPOSITORY || '';
const versionCode = Number(process.env.LUNA_VERSION_CODE || process.env.VERSION_CODE || 1);
fs.writeFileSync(
  path.join(webDir, 'update-config.js'),
  `window.LUNA_UPDATE_CONFIG = Object.freeze(${JSON.stringify({ repository, versionCode })});\n`
);

const androidDir = path.join(root, 'android');
const sdkDir = process.env.ANDROID_HOME ||
  process.env.ANDROID_SDK_ROOT ||
  path.join(os.homedir(), 'AppData', 'Local', 'Android', 'Sdk');
if (fs.existsSync(androidDir) && fs.existsSync(sdkDir)) {
  fs.writeFileSync(path.join(androidDir, 'local.properties'), `sdk.dir=${sdkDir.replace(/\\/g, '/')}\n`);
}

console.log(`Application Android préparée dans ${webDir}`);
