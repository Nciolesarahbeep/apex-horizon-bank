// Copies the website's public files into public/, which is the folder Netlify
// serves. Server code (api/, lib/, db/, netlify/) and project files stay out,
// so nobody can download them from the site. New pages, images or folders you
// add at the top level are picked up automatically.

const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const out = path.join(root, 'public');

const KEEP_PRIVATE = new Set([
  'public',
  'api',
  'lib',
  'db',
  'netlify',
  'node_modules',
  'package.json',
  'package-lock.json',
  'netlify.toml',
  'vercel.json',
  'README.md',
]);

fs.rmSync(out, { recursive: true, force: true });
fs.mkdirSync(out);

for (const name of fs.readdirSync(root)) {
  if (name.startsWith('.') || KEEP_PRIVATE.has(name)) continue;
  fs.cpSync(path.join(root, name), path.join(out, name), { recursive: true });
}

console.log('Published files:', fs.readdirSync(out).join(', '));
