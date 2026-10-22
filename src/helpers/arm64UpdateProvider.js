const { Provider } = require("electron-updater/out/providers/Provider");
const { verifyManifest, REPOSITORY } = require("./arm64UpdateManifest");

class Arm64UpdateProvider extends Provider {
  constructor(options, updater, runtimeOptions) {
    super(runtimeOptions);
    this.options = options;
    this.updater = updater;
    this.manifests = new Map();
  }

  async getLatestVersion() {
    const url = new URL(
      `https://github.com/${REPOSITORY}/releases/latest/download/arm64-update.json`
    );
    const raw = await this.httpRequest(url, { Accept: "application/json" });
    if (!raw || raw.length > 100000) throw new Error("Invalid ARM64 update response");
    const manifest = verifyManifest(
      JSON.parse(raw),
      this.options.publicKey,
      this.updater.currentVersion.version
    );
    this.manifests.set(manifest.version, manifest);
    this.options.onVerified(manifest);
    return {
      version: manifest.version,
      releaseDate: manifest.releaseDate,
      releaseNotes: manifest.releaseNotes || "Verified Windows ARM64 release",
      files: [
        {
          url: manifest.installer.url,
          sha512: manifest.installer.sha512,
          size: manifest.installer.size,
        },
      ],
      path: manifest.installer.url,
      sha512: manifest.installer.sha512,
    };
  }

  resolveFiles(info) {
    const manifest = this.manifests.get(info.version);
    if (!manifest) throw new Error("ARM64 update metadata has not been authenticated");
    return [
      {
        url: new URL(manifest.installer.url),
        info: {
          url: manifest.installer.url,
          sha512: manifest.installer.sha512,
          size: manifest.installer.size,
        },
      },
    ];
  }
}

module.exports = { Arm64UpdateProvider };
