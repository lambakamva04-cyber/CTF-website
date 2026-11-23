// Makes a one-time setup code for the admin page, valid for 24 hours. With it,
// whoever runs the site (or OMG) sets a new admin password on /admin/ under
// "Have a setup code?". Use it for the first password, or when it's forgotten.
//
//   npm run admin:setup-code            the live site
//   npm run admin:setup-code -- --local the local database (wrangler dev);
//                                       other options (--persist-to <dir>) go to wrangler
//
// Only the code's SHA-256 is stored. Making a new code replaces any unused one.
import { execFileSync } from 'node:child_process';
import { createHash, randomInt } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
const VALID_MS = 24 * 3_600_000;
const args = process.argv.slice(2);
const local = args.includes('--local');
const passOn = args.filter((a) => a !== '--local');

const code = Array.from({ length: 16 }, () => ALPHABET[randomInt(ALPHABET.length)]).join('');
const record = JSON.stringify({ hash: createHash('sha256').update(code).digest('hex'), expires: Date.now() + VALID_MS });
const sql = `INSERT INTO settings (key, value) VALUES ('admin_setup', '${record}') ON CONFLICT (key) DO UPDATE SET value = excluded.value`;

execFileSync('npx', ['wrangler', 'd1', 'execute', 'omg-oh-my-glam', local ? '--local' : '--remote', ...passOn, '--command', sql], {
  cwd: fileURLToPath(new URL('..', import.meta.url)),
  stdio: ['inherit', 'ignore', 'inherit'],
});
console.log(`\nSetup code: ${code.match(/.{4}/g).join('-')}`);
console.log('Valid for 24 hours, once. Open /admin/, tap "Have a setup code?", and choose the new password there.\n');
