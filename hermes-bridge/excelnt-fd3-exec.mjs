import { spawn } from "node:child_process";

const DEFAULT_MAX_BUFFER = 8 * 1024 * 1024;
const DEFAULT_TIMEOUT_KILL_GRACE_MS = 1000;

function commandError(code, stdout, stderr, signal = null, killed = false) {
  return Object.assign(new Error(String(code)), {
    code,
    signal,
    killed,
    stdout,
    stderr,
  });
}

/**
 * Spawn one local Hermes command with a one-shot capability on inherited FD 3.
 * Output buffering, timeout, and error shape match the Bridge's execFile call
 * closely, while avoiding execFile's fixed three-pipe stdio behavior.
 */
export function execFileWithFd3(file, args, options = {}) {
  const {
    fd3Input,
    maxBuffer = DEFAULT_MAX_BUFFER,
    timeout = 0,
    killSignal = "SIGTERM",
    encoding = "utf8",
    onChildStarted,
    onChildClosed,
    ...spawnOptions
  } = options;
  if (!(typeof fd3Input === "string" || Buffer.isBuffer(fd3Input))
      || (Buffer.isBuffer(fd3Input) ? fd3Input.length : Buffer.byteLength(fd3Input)) > 512) {
    return Promise.reject(commandError("fd3_input_invalid", "", ""));
  }
  if (!Number.isSafeInteger(maxBuffer) || maxBuffer < 1
      || !Number.isFinite(timeout) || timeout < 0
      || !["utf8", "buffer"].includes(encoding)) {
    return Promise.reject(commandError("fd3_options_invalid", "", ""));
  }

  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawn(file, args, {
        ...spawnOptions,
        stdio: ["ignore", "pipe", "pipe", "pipe"],
      });
    } catch {
      reject(commandError("child_spawn_failed", "", ""));
      return;
    }
    if (!child.stdio?.[3]) {
      child.kill("SIGKILL");
      reject(commandError("fd3_channel_unavailable", "", "", null, true));
      return;
    }

    let stdoutBytes = 0;
    let stderrBytes = 0;
    const stdoutChunks = [];
    const stderrChunks = [];
    let overflowStream = null;
    let setupFailed = false;
    let timeoutExpired = false;
    let closed = false;
    let forceKillTimer = null;
    const output = (chunks) => {
      const buffer = Buffer.concat(chunks);
      return encoding === "buffer" ? buffer : buffer.toString(encoding);
    };
    const stopChild = () => {
      if (child.exitCode !== null || child.signalCode !== null) return;
      try { child.kill(killSignal); } catch {}
      forceKillTimer ??= setTimeout(() => {
        if (child.exitCode === null && child.signalCode === null) {
          try { child.kill("SIGKILL"); } catch {}
        }
      }, DEFAULT_TIMEOUT_KILL_GRACE_MS);
      forceKillTimer.unref?.();
    };

    child.stdout.on("data", (chunk) => {
      stdoutBytes += chunk.length;
      if (stdoutBytes > maxBuffer) {
        overflowStream ??= "stdout";
        stopChild();
        return;
      }
      stdoutChunks.push(chunk);
    });
    child.stderr.on("data", (chunk) => {
      stderrBytes += chunk.length;
      if (stderrBytes > maxBuffer) {
        overflowStream ??= "stderr";
        stopChild();
        return;
      }
      stderrChunks.push(chunk);
    });
    // A fast local response may close FD 3 before any MAX tool reads it.
    // A truncated capability cannot pass the tool's exact token validation.
    child.stdio[3].on("error", () => {});
    child.once("error", () => {
      overflowStream ??= "spawn";
      stopChild();
    });
    child.once("close", (exitCode, signal) => {
      if (closed) return;
      closed = true;
      if (timeoutTimer) clearTimeout(timeoutTimer);
      if (forceKillTimer) clearTimeout(forceKillTimer);
      try { onChildClosed?.(child); } catch {}
      const stdout = output(stdoutChunks);
      const stderr = output(stderrChunks);
      if (timeoutExpired) return reject(commandError("ETIMEDOUT", stdout, stderr, signal, true));
      if (setupFailed) return reject(commandError("fd3_channel_failed", stdout, stderr, signal, true));
      if (overflowStream) {
        const code = overflowStream === "spawn" ? "child_spawn_failed" : "ERR_CHILD_PROCESS_STDIO_MAXBUFFER";
        return reject(commandError(code, stdout, stderr, signal, true));
      }
      if (exitCode !== 0) {
        const code = Number.isInteger(exitCode) ? exitCode : signal || "CHILD_PROCESS_FAILED";
        return reject(commandError(code, stdout, stderr, signal, Boolean(signal)));
      }
      resolve({ stdout, stderr });
    });

    let timeoutTimer = null;
    if (timeout > 0) {
      timeoutTimer = setTimeout(() => {
        timeoutExpired = true;
        stopChild();
      }, timeout);
      timeoutTimer.unref?.();
    }
    try {
      onChildStarted?.(child);
      child.stdio[3].end(fd3Input);
    } catch {
      setupFailed = true;
      stopChild();
      try { child.stdio[3].destroy(); } catch {}
    }
  });
}
