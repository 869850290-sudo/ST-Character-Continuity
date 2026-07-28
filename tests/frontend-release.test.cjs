const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "..");
const read = (file) => fs.readFileSync(path.join(root, file), "utf8");

test("v0.4.6 frontend release is visibly versioned and cache-busted", () => {
  const manifest = JSON.parse(read("manifest.json"));
  const entry = read("index.js");
  const workspace = read("scripts/workspace.js");

  assert.equal(manifest.version, "0.4.6");
  assert.equal(manifest.auto_update, true);
  assert.match(entry, /workspace\.js\?v=0\.4\.6/);
  assert.match(workspace, /ccm-version">v\$\{FRONTEND_VERSION\}/);
});

test("legacy chat messages keep their content and string boolean flags", () => {
  const entry = read("index.js");
  const flagSource = entry.match(/function messageFlag\(value\) \{[\s\S]*?\n\}/)?.[0];
  const textSource = entry.match(/function messageText\(message\) \{[\s\S]*?\n\}/)?.[0];
  const messageFlag = Function(`${flagSource}; return messageFlag;`)();
  const messageText = Function(`${textSource}; return messageText;`)();

  assert.match(entry, /function messageFlag/);
  assert.match(entry, /message\?\.mes \?\? message\?\.content \?\? message\?\.text/);
  assert.match(entry, /message\.mes && !message\.is_continuity_injection/);
  assert.equal(messageFlag("false"), false);
  assert.equal(messageFlag("true"), true);
  assert.equal(messageText({ content: "旧格式正文" }), "旧格式正文");
});

test("library editor uses a native top-layer dialog", () => {
  const workspace = read("scripts/workspace.js");
  const styles = read("style.css");

  assert.match(workspace, /<dialog id="ccm-library-dialog"/);
  assert.match(workspace, /dialog\.showModal/);
  assert.match(styles, /\.ccm-native-dialog\[open\]/);
});

test("profile and relation editors use native top-layer dialogs", () => {
  const workspace = read("scripts/workspace.js");

  assert.match(workspace, /<dialog id="ccm-profile-dialog"/);
  assert.match(workspace, /<dialog id="ccm-relation-dialog"/);
  assert.doesNotMatch(workspace, /<div class="ccm-modal-backdrop"/);
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
