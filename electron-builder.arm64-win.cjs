// Construct from the shared config without `extends`: electron-builder merges
// inherited resource arrays, which otherwise copies/signs the same EXEs twice.
const fs = require("fs");
const path = require("path");
const shared = require("./electron-builder.json");

// 7za 24 auto-selects ARM64 filters that the bundled legacy Nsis7z decoder
// silently skips. Single-stream BCJ preserves every PE during installation.
// https://github.com/electron-userland/electron-builder/issues/9983
process.env.ELECTRON_BUILDER_7Z_FILTER = "BCJ";

module.exports = {
  ...shared,
  extraMetadata: { ...shared.extraMetadata, windowsTrayIdentity: false, localArm64Build: true },
  win: {
    ...shared.win,
    azureSignOptions: null,
    forceCodeSigning: false,
    target: [{ target: "nsis", arch: ["arm64"] }],
    artifactName: "${productName}-${version}-windows-arm64.${ext}",
    extraResources: [],
  },
  nsis: { ...shared.nsis, packElevateHelper: false },
  extraResources: [
    ...(fs.existsSync(path.join(__dirname, ".env")) ? [".env"] : []),
    { from: "src/assets", to: "src/assets", filter: ["**/*", "!fonts/yowza/**"] },
    {
      from: "resources/bin",
      to: "bin",
      filter: [
        "**/*",
        "!*x64*",
        "!*darwin*",
        "!*linux*",
        "!nircmd.exe",
        "!*.zip",
        "!*.tar.*",
        "!.*",
      ],
    },
  ],
  publish: null,
  afterAllArtifactBuild: async (context) => {
    const appDir = path.join(context.outDir, "win-arm64-unpacked");
    const { validateArm64Package } = require("./scripts/lib/validate-arm64-package");
    const count = validateArm64Package(appDir);
    fs.writeFileSync(
      path.join(context.outDir, "windows-arm64-architecture.json"),
      JSON.stringify({ architecture: "arm64", checkedImages: count }, null, 2)
    );
    return [];
  },
};
