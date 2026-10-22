const debugLogger = require("./debugLogger");

const CACHE_TTL_MS = 5000;

class ProcessListCache {
  constructor() {
    this._cache = null;
    this._cacheTime = 0;
    this._pending = null;
  }

  async getProcessList() {
    const now = Date.now();
    if (this._cache && now - this._cacheTime < CACHE_TTL_MS) {
      return this._cache;
    }

    if (this._pending) return this._pending;

    this._pending = this._fetch(now);
    try {
      return await this._pending;
    } finally {
      this._pending = null;
    }
  }

  async _fetch(now) {
    try {
      let procs;
      if (process.platform === "win32" && process.arch === "arm64") {
        const { resolveBinaryPath } = require("../utils/serverUtils");
        const { assertPeArchitecture } = require("./peArchitecture");
        const { execFile } = require("child_process");
        const { promisify } = require("util");
        const binary = resolveBinaryPath("windows-process-list.exe");
        if (!binary) throw new Error("ARM64 process-list helper is missing");
        assertPeArchitecture(binary);
        const { stdout } = await promisify(execFile)(binary, [], {
          windowsHide: true,
          timeout: 5000,
          encoding: "utf8",
        });
        procs = stdout
          .split(/\r?\n/)
          .filter(Boolean)
          .map((name) => ({ name }));
      } else {
        const psList = (await import("ps-list")).default;
        procs = await psList();
      }
      const names = procs.map((p) => (p.name || "").toLowerCase());
      this._cache = names;
      this._cacheTime = now;
      debugLogger.debug("Process list refreshed", { count: names.length }, "meeting");
      return names;
    } catch (err) {
      debugLogger.warn("Failed to fetch process list", { error: err.message }, "meeting");
      return [];
    }
  }

  invalidate() {
    this._cache = null;
    this._cacheTime = 0;
    this._pending = null;
  }
}

module.exports = new ProcessListCache();
