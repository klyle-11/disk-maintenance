/**
 * electron-builder afterPack hook.
 *
 * The bundled Python backend is a nested executable inside the .app. macOS
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

exports.default = async function afterPack(context) {
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
