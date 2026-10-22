const { test } = require("node:test");
const assert = require("node:assert/strict");
const { buildEnvironment } = require("../../scripts/build-windows-arm64-renderer");

test("ARM64 hosted auth has a matching cloud API for policy resolution", () => {
  assert.equal(buildEnvironment({}).VITE_OPENWHISPR_API_URL, "https://api.openwhispr.com");
  assert.equal(
    buildEnvironment({ VITE_OPENWHISPR_API_URL: "https://custom.example" }).VITE_OPENWHISPR_API_URL,
    "https://custom.example"
  );
  assert.equal(
    buildEnvironment({ OPENWHISPR_API_URL: "https://runtime.example" }).VITE_OPENWHISPR_API_URL,
    "https://runtime.example"
  );
  assert.equal(
    buildEnvironment({}, { VITE_OPENWHISPR_API_URL: "https://dotenv.example" })
      .VITE_OPENWHISPR_API_URL,
    "https://dotenv.example"
  );
  assert.equal(
    buildEnvironment({ VITE_AUTH_URL: "https://auth.custom.example" }).VITE_OPENWHISPR_API_URL,
    undefined
  );
  const customAuth = buildEnvironment({ AUTH_URL: "https://auth.custom.example" });
  assert.equal(customAuth.VITE_AUTH_URL, "https://auth.custom.example");
  assert.equal(customAuth.VITE_OPENWHISPR_API_URL, undefined);
  const conflictingAuth = buildEnvironment({
    AUTH_URL: "https://auth.custom.example",
    VITE_AUTH_URL: "https://auth.openwhispr.com",
  });
  assert.equal(conflictingAuth.VITE_AUTH_URL, "https://auth.custom.example");
  assert.equal(conflictingAuth.VITE_OPENWHISPR_API_URL, undefined);
});

test("ARM64 NSIS uses a decodable archive filter and one resource copy per destination", () => {
  const config = require("../../electron-builder.arm64-win.cjs");
  assert.equal(process.env.ELECTRON_BUILDER_7Z_FILTER, "BCJ");
  assert.equal(config.extraMetadata.localArm64Build, true);
  assert.equal(config.win.forceCodeSigning, false);
  assert.equal(config.nsis.packElevateHelper, false);
  if (process.env.OPENWHISPR_MANAGED_RELEASE === "1") {
    assert.equal(config.publish.repo, "openwhispr-arm64");
    assert.equal(config.publish.owner, "luisfranciscor505");
  } else assert.equal(config.publish, null);
  const destinations = config.extraResources.map((item) =>
    typeof item === "string" ? item : item.to
  );
  assert.equal(new Set(destinations).size, destinations.length);
  assert.equal(config.win.extraResources.length, 0);
});
