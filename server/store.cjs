"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { EMPTY_STATE, normalizeState } = require("./state.cjs");

class StateStore {
  constructor(root) {
    this.root = root;
    this.backupRoot = path.join(root, "backups");
    this.statePath = path.join(root, "state.json");
    this.queue = Promise.resolve();
  }

  async initialize() {
    await fs.promises.mkdir(this.backupRoot, { recursive: true });
    if (!fs.existsSync(this.statePath)) {
      await this.#writeAtomic(normalizeState(EMPTY_STATE));
    }
  }

  async read() {
    await this.initialize();
    const raw = await fs.promises.readFile(this.statePath, "utf8");
    return normalizeState(JSON.parse(raw));
  }

  async replace(nextState, reason = "replace") {
    const normalized = normalizeState(nextState);
    this.queue = this.queue.then(async () => {
      await this.initialize();
      const current = await fs.promises.readFile(this.statePath, "utf8");
      const stamp = new Date().toISOString().replace(/[:.]/g, "-");
      const safeReason = String(reason).replace(/[^\p{L}\p{N}_-]+/gu, "_").slice(0, 40);
      const backupPath = path.join(this.backupRoot, `${stamp}-${safeReason || "backup"}.json`);
      await fs.promises.writeFile(backupPath, current, "utf8");
      await this.#writeAtomic(normalized);
      await this.#trimBackups();
      return normalized;
    });
    return this.queue;
  }

  async #writeAtomic(state) {
    await fs.promises.mkdir(this.root, { recursive: true });
    const temporary = `${this.statePath}.tmp-${process.pid}`;
    await fs.promises.writeFile(temporary, JSON.stringify(state, null, 2), "utf8");
    await fs.promises.rename(temporary, this.statePath);
  }

  async #trimBackups() {
    const files = (await fs.promises.readdir(this.backupRoot))
      .filter((name) => name.endsWith(".json"))
      .sort()
      .reverse();
    await Promise.all(
      files.slice(20).map((name) =>
        fs.promises.unlink(path.join(this.backupRoot, name)).catch(() => {})),
    );
  }
}

module.exports = { StateStore };

