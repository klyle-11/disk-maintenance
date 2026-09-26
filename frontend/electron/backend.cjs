/**
 * Backend process supervision.
 * ============================
 * Owns the lifecycle of the bundled Python backend: locating it, clearing the
 * macOS quarantine flag that would otherwise get it killed on sight, picking a
 * free port, starting it, watching it, and shutting it down cleanly.
 *
 * Emits status updates so the UI can show what is happening instead of a modal
 * error box.
 */

const { EventEmitter } = require('events');
const { spawn, execFile } = require('child_process');
const fs = require('fs');
const http = require('http');
const net = require('net');
const os = require('os');
const path = require('path');

const DEFAULT_PORT = 8001;
const PORT_SEARCH_RANGE = 20;
// A PyInstaller one-file bundle unpacks ~27MB to a temp dir on every launch,
// and on first run macOS also scans it. 15s was not enough; this is.
const READY_TIMEOUT_MS = 120000;
const HEALTH_POLL_MS = 400;
const MAX_RESTARTS = 3;

class BackendSupervisor extends EventEmitter {
  constructor({ isDev, logPath }) {
    super();
    this.isDev = isDev;
    this.logPath = logPath;
    this.proc = null;
    this.port = DEFAULT_PORT;
    this.host = '127.0.0.1';
    this.state = 'idle';
    this.detail = '';
    this.restarts = 0;
    this.stopping = false;
    this.logStream = null;
    this.recentLines = [];
  }

  // --------------------------------------------------------------------
  // status
  // --------------------------------------------------------------------

  setState(state, detail = '') {
    this.state = state;
    this.detail = detail;
    this.emit('status', this.status());
  }

  status() {
    return {
      state: this.state,
      detail: this.detail,
      port: this.port,
      baseUrl: `http://${this.host}:${this.port}`,
      logPath: this.logPath,
      restarts: this.restarts,
      recentLines: this.recentLines.slice(-40),
    };
  }

  log(line) {
    const stamped = `[${new Date().toISOString()}] ${line}`;
    console.log(stamped);
    this.recentLines.push(line);
    if (this.recentLines.length > 200) this.recentLines.shift();
    try {
      if (!this.logStream) {
        fs.mkdirSync(path.dirname(this.logPath), { recursive: true });
        this.logStream = fs.createWriteStream(this.logPath, { flags: 'a' });
      }
      this.logStream.write(`${stamped}\n`);
    } catch {
      // Logging must never be the reason startup fails.
    }
  }

  // --------------------------------------------------------------------
  // locating the executable
  // --------------------------------------------------------------------

  executablePath() {
    const name =
      process.platform === 'win32'
        ? 'disk-intelligence-backend.exe'
        : 'disk-intelligence-backend';

    const candidates = [
      path.join(process.resourcesPath || '', 'backend', name),
      // Running `electron .` against a locally built backend.
      path.join(__dirname, '..', '..', 'backend', 'dist', name),
    ];

    for (const candidate of candidates) {
      if (candidate && fs.existsSync(candidate)) return candidate;
    }
    return null;
  }

  /**
   * Clear the macOS quarantine flag from the bundled backend.
   *
   * This is the single most common cause of "the backend didn't start" on a
   * Mac. Anything downloaded gets com.apple.quarantine applied to every file
   * in the bundle. LaunchServices clears it for the app's own executable when
   * the user opens it, but nested helper binaries keep it — and an ad-hoc
   * signed, quarantined binary is SIGKILLed by Gatekeeper the instant it is
   * exec'd, with no error message and no output at all.
   *
   * Best effort: if the app lives somewhere unwritable this is a no-op and we
   * fall through to a clear error rather than a mystery timeout.
   */
  async clearQuarantine(exePath) {
    if (process.platform !== 'darwin') return;

    const run = (cmd, args) =>
      new Promise((resolve) => {
        execFile(cmd, args, { timeout: 15000 }, (err, stdout, stderr) => {
          resolve({ err, stdout, stderr });
        });
      });

    const { err } = await run('xattr', ['-d', 'com.apple.quarantine', exePath]);
    if (!err) {
      this.log('[backend] cleared com.apple.quarantine from the backend binary');
    }

    // Clear it from the whole resources tree too; a quarantined parent
    // directory can re-taint files, and the check is cheap.
    await run('xattr', ['-dr', 'com.apple.quarantine', path.dirname(exePath)]);

    // A missing or broken signature is the other way Gatekeeper kills it.
    const { err: verifyErr } = await run('codesign', ['--verify', '--no-strict', exePath]);
    if (verifyErr) {
      this.log('[backend] signature invalid — re-signing ad-hoc');
      await run('codesign', ['--force', '--sign', '-', exePath]);
    }
  }

  // --------------------------------------------------------------------
  // ports
  // --------------------------------------------------------------------

  probePort(port) {
    return new Promise((resolve) => {
      const server = net.createServer();
      server.once('error', () => resolve(false));
      server.once('listening', () => server.close(() => resolve(true)));
      server.listen(port, this.host);
    });
  }

  /**
   * Ask whoever is on `port` whether they are one of our backends.
   * Never assume — an unrelated process on 8001 used to make the app hang
   * forever waiting for a health check that would never pass.
   */
  probeHealth(port, timeoutMs = 1200) {
    return new Promise((resolve) => {
      const req = http.get(
        { host: this.host, port, path: '/api/health', timeout: timeoutMs },
        (res) => {
          let body = '';
          res.on('data', (chunk) => (body += chunk));
          res.on('end', () => {
            resolve(res.statusCode === 200 && body.includes('ok'));
          });
        }
      );
      req.on('error', () => resolve(false));
      req.on('timeout', () => {
        req.destroy();
        resolve(false);
      });
    });
  }

  async choosePort() {
    // Reuse a backend that is already healthy (e.g. a dev server, or a second
    // window of this app).
    if (await this.probeHealth(DEFAULT_PORT)) {
      this.log(`[backend] reusing healthy backend already on ${DEFAULT_PORT}`);
      return { port: DEFAULT_PORT, reuse: true };
    }

    for (let port = DEFAULT_PORT; port < DEFAULT_PORT + PORT_SEARCH_RANGE; port++) {
      if (await this.probePort(port)) {
        if (port !== DEFAULT_PORT) {
          this.log(`[backend] port ${DEFAULT_PORT} is taken by something else, using ${port}`);
        }
        return { port, reuse: false };
      }
    }
    throw new Error(
      `No free port between ${DEFAULT_PORT} and ${DEFAULT_PORT + PORT_SEARCH_RANGE}`
    );
  }

  // --------------------------------------------------------------------
  // lifecycle
  // --------------------------------------------------------------------

  async start() {
    this.stopping = false;

    if (this.isDev) {
      // The dev backend is run separately by `npm run dev`.
      this.setState('starting', 'waiting for the development backend');
      const ok = await this.waitForHealth(this.port, 30000);
      this.setState(ok ? 'ready' : 'error', ok ? '' : 'development backend is not running');
      return ok;
    }

    const exePath = this.executablePath();
    if (!exePath) {
      this.setState(
        'error',
        'The backend executable is missing from this installation. Reinstall the app, or build it with scripts/build-backend.sh.'
      );
      return false;
    }

    this.setState('starting', 'preparing the backend');
    await this.clearQuarantine(exePath);

    let chosen;
    try {
      chosen = await this.choosePort();
    } catch (err) {
      this.setState('error', err.message);
      return false;
    }
    this.port = chosen.port;

    if (chosen.reuse) {
      this.setState('ready', '');
      return true;
    }

    this.setState('starting', 'starting the backend');
    return this.spawnBackend(exePath);
  }

  async spawnBackend(exePath) {
    this.log(`[backend] spawning ${exePath} on port ${this.port}`);

    try {
      this.proc = spawn(exePath, ['--port', String(this.port)], {
        stdio: ['ignore', 'pipe', 'pipe'],
        env: {
          ...process.env,
          BACKEND_PORT: String(this.port),
          // Unbuffered output so the log is useful while it is still starting.
          PYTHONUNBUFFERED: '1',
        },
        // Own process group, so shutdown can take the whole tree down. A
        // PyInstaller bundle forks a child; signalling only the parent used to
        // leave an orphan holding the port.
        detached: process.platform !== 'win32',
        windowsHide: true,
      });
    } catch (err) {
      this.setState('error', `Could not launch the backend: ${err.message}`);
      return false;
    }

    this.proc.stdout.on('data', (d) => this.log(`[backend] ${d.toString().trimEnd()}`));
    this.proc.stderr.on('data', (d) => this.log(`[backend] ${d.toString().trimEnd()}`));

    this.proc.on('error', (err) => {
      this.log(`[backend] spawn error: ${err.message}`);
      this.setState('error', `Could not launch the backend: ${err.message}`);
    });

    this.proc.on('exit', (code, signal) => {
      this.log(`[backend] exited (code=${code}, signal=${signal})`);
      this.proc = null;
      if (this.stopping) return;

      // SIGKILL with no output is the Gatekeeper signature. Say so plainly
      // rather than reporting a generic timeout.
      if (signal === 'SIGKILL' && this.state !== 'ready') {
        this.setState(
          'error',
          'macOS blocked the backend from running. Move the app to /Applications and open it once from Finder, or run:  xattr -dr com.apple.quarantine "/Applications/Disk Intelligence.app"'
        );
        return;
      }

      if (this.restarts < MAX_RESTARTS) {
        this.restarts += 1;
        this.setState('restarting', `backend stopped unexpectedly — restart ${this.restarts}/${MAX_RESTARTS}`);
        setTimeout(() => {
          if (!this.stopping) this.start();
        }, 1000);
      } else {
        this.setState('error', 'The backend keeps stopping. See the log for details.');
      }
    });

    const ok = await this.waitForHealth(this.port, READY_TIMEOUT_MS);
    if (ok) {
      this.restarts = 0;
      this.setState('ready', '');
      this.log('[backend] ready');
      return true;
    }

    if (this.state !== 'error') {
      this.setState('error', 'The backend did not become ready in time. See the log for details.');
    }
    return false;
  }

  /** Poll /api/health until it answers, the process dies, or we run out of time. */
  async waitForHealth(port, timeoutMs) {
    const deadline = Date.now() + timeoutMs;
    let attempt = 0;
    while (Date.now() < deadline) {
      if (this.stopping) return false;
      if (await this.probeHealth(port)) return true;

      // Give up early when the process is already gone; its exit handler
      // produces a much better message than a timeout would.
      if (!this.isDev && !this.proc && attempt > 0) return false;

      attempt += 1;
      if (attempt % 10 === 0) {
        const waited = Math.round((timeoutMs - (deadline - Date.now())) / 1000);
        this.setState('starting', `starting the backend… (${waited}s)`);
      }
      await new Promise((resolve) => setTimeout(resolve, HEALTH_POLL_MS));
    }
    return false;
  }

  /** Stop the backend and everything it spawned. */
  stop() {
    this.stopping = true;
    const proc = this.proc;
    this.proc = null;
    if (!proc || proc.killed) return;

    this.log('[backend] stopping');
    try {
      if (process.platform === 'win32') {
        spawn('taskkill', ['/pid', String(proc.pid), '/f', '/t'], { windowsHide: true });
      } else {
        // Negative pid targets the whole process group, so the PyInstaller
        // child goes down with its parent instead of orphaning the port.
        try {
          process.kill(-proc.pid, 'SIGTERM');
        } catch {
          proc.kill('SIGTERM');
        }
        setTimeout(() => {
          try {
            process.kill(-proc.pid, 'SIGKILL');
          } catch {
            /* already gone */
          }
        }, 3000).unref?.();
      }
    } catch (err) {
      this.log(`[backend] error while stopping: ${err.message}`);
    }
  }

  /** Manual retry from the UI. */
  async retry() {
    this.stop();
    this.stopping = false;
    this.restarts = 0;
    await new Promise((resolve) => setTimeout(resolve, 400));
    return this.start();
  }
}

module.exports = { BackendSupervisor, DEFAULT_PORT };
