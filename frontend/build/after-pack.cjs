/**
 * electron-builder afterPack hook.
 *
 * First, on every platform: refuse to ship a backend binary built from older
 * code than the backend source. electron-builder copies whatever is in
 * backend/dist, and `npm run dist` doesn't rebuild it, so a stale build used to
 * ship silently and the app then 404'd on every newer endpoint.
 *
 * Then, on macOS: the bundled Python backend is a nested executable inside the .app. macOS
 * treats those far more harshly than the app's own binary:
 *
 *   - Anything downloaded gets com.apple.quarantine on every file. Launch
 *     Services clears it for the app the user double-clicks, but not for
 *     nested helpers — and exec'ing a quarantined, ad-hoc signed binary gets
 *     it SIGKILLed instantly, with no error and no output. That is the
 *     "backend didn't start" failure.
 *   - Under a hardened runtime an unsigned or wrongly-entitled nested binary
 *     is refused too.
 *
 * So: sign the backend with the entitlements it needs, before electron-builder
 * signs the outer bundle, and strip any quarantine that came along for the
 * ride. The app still also self-heals at launch (see electron/backend.cjs),
 * because a user can always re-download and re-quarantine it.
 */

const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const BACKEND_DIR = path.join(__dirname, '..', '..', 'backend');
const NOT_SOURCE = new Set(['venv', 'dist', 'build', 'tests', '__pycache__', '.pytest_cache']);

/** The most recently changed file the backend binary is built from. */
function newestSource(dir, newest = { file: null, mtime: 0 }) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (!NOT_SOURCE.has(entry.name)) newestSource(full, newest);
    } else if (/\.(py|spec)$/.test(entry.name)) {
      const { mtimeMs } = fs.statSync(full);
      if (mtimeMs > newest.mtime) Object.assign(newest, { file: full, mtime: mtimeMs });
    }
  }
  return newest;
}

function checkBackendIsCurrent(platform) {
  const name = platform === 'win32' ? 'disk-intelligence-backend.exe' : 'disk-intelligence-backend';
  const binary = path.join(BACKEND_DIR, 'dist', name);
  if (!fs.existsSync(binary)) {
    console.warn(`[after-pack] backend/dist/${name} is missing — the app will say so at launch`);
    return;
  }
  const source = newestSource(BACKEND_DIR);
  if (source.mtime <= fs.statSync(binary).mtimeMs) return;
  const changed = path.relative(BACKEND_DIR, source.file);
  if (process.env.DI_ALLOW_STALE_BACKEND === '1') {
    console.warn(`[after-pack] backend/dist/${name} is older than backend/${changed} — packaging it anyway`);
    return;
  }
  throw new Error(
    `[after-pack] backend/dist/${name} is older than backend/${changed}: it was built from older ` +
      'code and the app would 404 on newer endpoints. Run scripts/build-backend.sh, then package again ' +
      '(or set DI_ALLOW_STALE_BACKEND=1 to ship it anyway).'
  );
}

exports.default = async function afterPack(context) {
  checkBackendIsCurrent(context.electronPlatformName);
  if (context.electronPlatformName !== 'darwin') return;

  const appName = context.packager.appInfo.productFilename;
  const backendPath = path.join(
    context.appOutDir,
    `${appName}.app`,
    'Contents',
    'Resources',
    'backend',
    'disk-intelligence-backend'
  );

  if (!fs.existsSync(backendPath)) {
    console.warn(`[after-pack] backend not found at ${backendPath} — skipping`);
    return;
  }

  const entitlements = path.join(__dirname, '..', '..', 'backend', 'entitlements.plist');

  const run = (cmd, args) => {
    try {
      execFileSync(cmd, args, { stdio: 'pipe' });
      return true;
    } catch (err) {
      console.warn(`[after-pack] ${cmd} ${args.join(' ')} failed: ${err.message}`);
      return false;
    }
  };

  // Executable bit can be lost depending on how the file was copied.
  fs.chmodSync(backendPath, 0o755);

  run('xattr', ['-cr', backendPath]);

  const identity = process.env.CSC_NAME || '-';
  const signArgs = [
    '--force',
    '--timestamp=none',
    '--options', 'runtime',
    '--sign', identity,
  ];
  if (fs.existsSync(entitlements)) {
    signArgs.push('--entitlements', entitlements);
  }
  signArgs.push(backendPath);

  if (run('codesign', signArgs)) {
    console.log(
      `[after-pack] signed the backend (${identity === '-' ? 'ad-hoc' : identity})`
    );
  }

  // Fail loudly here rather than shipping something that dies on the user's machine.
  if (!run('codesign', ['--verify', '--strict', backendPath])) {
    throw new Error('[after-pack] backend signature did not verify — refusing to ship');
  }
  console.log('[after-pack] backend signature verified');
};
