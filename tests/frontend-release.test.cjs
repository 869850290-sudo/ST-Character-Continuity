const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "..");
const read = (file) => fs.readFileSync(path.join(root, file), "utf8");

test("v0.4.4 frontend release is visibly versioned and cache-busted", () => {
  const manifest = JSON.parse(read("manifest.json"));
  const entry = read("index.js");
  const workspace = read("scripts/workspace.js");

  assert.equal(manifest.version, "0.4.4");
  assert.equal(manifest.auto_update, true);
  assert.match(entry, /workspace\.js\?v=0\.4\.4/);
  assert.match(workspace, /ccm-version">v\$\{FRONTEND_VERSION\}/);
});

test("library editor uses a native top-layer dialog", () => {
  const workspace = read("scripts/workspace.js");
  const styles = read("style.css");

  assert.match(workspace, /<dialog id="ccm-library-dialog"/);
  assert.match(workspace, /dialog\.showModal/);
  assert.match(styles, /\.ccm-native-dialog\[open\]/);
});

test("analysis range persists and preview uses a native top-layer dialog", () => {
  const workspace = read("scripts/workspace.js");

  assert.match(workspace, /analysisRangeStart/);
  assert.match(workspace, /analysisRangeEnd/);
  assert.match(workspace, /event\.target\.id === "ccm-analysis-start"/);
  assert.match(workspace, /<dialog id="ccm-range-dialog"/);
});

test("workspace supports real touch activation and clear disabled styling", () => {
  const workspace = read("scripts/workspace.js");
  const styles = read("style.css");

  assert.match(workspace, /addEventListener\("pointerup", dispatchWorkspaceAction/);
  assert.match(workspace, /event\.pointerType === "mouse"/);
  assert.match(styles, /#ccm-overlay button:disabled/);
  assert.match(styles, /cursor: not-allowed/);
});
