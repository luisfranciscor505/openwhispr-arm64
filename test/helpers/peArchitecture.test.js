const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { assertPeArchitecture, readPeMachine } = require("../../src/helpers/peArchitecture");

test("PE validation rejects x64, truncated, and invalid cached images", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ow-pe-"));
  const file = path.join(dir, "helper.exe");
  try {
    const image = Buffer.alloc(134);
    image.writeUInt16LE(0x5a4d, 0);
    image.writeUInt32LE(128, 0x3c);
    image.writeUInt32LE(0x4550, 128);
    image.writeUInt16LE(0xaa64, 132);
    fs.writeFileSync(file, image);
    assert.equal(readPeMachine(file), 0xaa64);
    assert.equal(assertPeArchitecture(file), file);
    image.writeUInt16LE(0x8664, 132);
    fs.writeFileSync(file, image);
    assert.throws(() => assertPeArchitecture(file), /Wrong architecture/);
    fs.writeFileSync(file, image.subarray(0, 129));
    assert.throws(() => readPeMachine(file), /Invalid PE/);
    fs.writeFileSync(file, "not an executable");
    assert.throws(() => readPeMachine(file), /Not a Windows PE/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
