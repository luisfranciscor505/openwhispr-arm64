const fs = require("fs");
const path = require("path");
const { assertPeArchitecture } = require("../../src/helpers/peArchitecture");

function validateArm64Package(root) {
  let count = 0;
  function visit(dir) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const file = path.join(dir, entry.name);
      if (entry.isDirectory()) visit(file);
      else if (/\.(exe|dll|node)$/i.test(entry.name)) {
        assertPeArchitecture(file);
        count++;
      }
    }
  }
  visit(root);
  if (!count) throw new Error(`No native binaries found in ${root}`);
  console.log(`Verified ${count} ARM64 PE images in ${root}`);
  return count;
}

module.exports = { validateArm64Package };
