import fs from 'node:fs';
if (!fs.existsSync('dist/index.html')) throw new Error('Run npm run build first.');
const destination = 'android/app/src/main/assets/public';
fs.rmSync(destination, { recursive: true, force: true }); fs.mkdirSync(destination, { recursive: true });
fs.cpSync('dist', destination, { recursive: true });
console.log('Bundled only production assets into the native app. No dev server, credentials, remote site, WASM or models.');
