import fs from 'node:fs';
const text=fs.readFileSync(process.argv[2],'utf8');
const expected=JSON.parse(fs.readFileSync('docs/signing-identity.json')).certificateSha256.replaceAll(':','').toLowerCase();
const actual=text.match(/certificate SHA-256 digest:\s*([a-f0-9]+)/i)?.[1].toLowerCase();
if(!actual||actual!==expected)throw new Error('APK signer does not match the owner-controlled public certificate. Release refused.');
console.log('APK signer matches the pinned public owner certificate.');
