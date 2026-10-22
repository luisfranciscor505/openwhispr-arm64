const crypto = require("node:crypto");
const fs = require("node:fs");
const semver = require("semver");

const REPOSITORY = "luisfranciscor505/openwhispr-arm64";
const APP_ID = "com.gizmolabs.openwhispr";

function assetUrl(version, filename) {
  return `https://github.com/${REPOSITORY}/releases/download/v${version}/${filename}`;
}

function verifyManifest(envelope, publicKey, currentVersion) {
  if (
    !envelope ||
    typeof envelope.payload !== "string" ||
    envelope.payload.length > 65536 ||
    typeof envelope.signature !== "string"
  )
    throw new Error("Invalid ARM64 update envelope");
  const bytes = Buffer.from(envelope.payload, "base64");
  const key = crypto.createPublicKey(publicKey);
  if (
    key.asymmetricKeyType !== "ed25519" ||
    !crypto.verify(null, bytes, key, Buffer.from(envelope.signature, "base64"))
  ) {
    throw new Error("ARM64 update signature is invalid");
  }
  const manifest = JSON.parse(bytes.toString("utf8"));
  const version = semver.valid(manifest.version);
  if (
    manifest.schema !== 1 ||
    manifest.appId !== APP_ID ||
    manifest.platform !== "win32" ||
    manifest.arch !== "arm64" ||
    manifest.repository !== REPOSITORY ||
    !version ||
    !/^\d+\.\d+\.\d+-arm64\.[1-9]\d*$/.test(version) ||
    !/^[a-f0-9]{40}$/.test(manifest.sourceCommit) ||
    !/^[a-f0-9]{40}$/.test(manifest.upstreamCommit) ||
    !Number.isSafeInteger(manifest.installer?.size) ||
    manifest.installer.size <= 0 ||
    !/^[A-Za-z0-9+/]{86}==$/.test(manifest.installer.sha512)
  ) {
    throw new Error("Incompatible ARM64 update manifest");
  }
  const expected = assetUrl(version, `OpenWhispr-${version}-windows-arm64.exe`);
  if (manifest.installer.url !== expected) throw new Error("Unauthorized ARM64 update asset URL");
  if (semver.lt(version, currentVersion)) throw new Error("ARM64 update downgrade rejected");
  return Object.freeze({ ...manifest, installer: Object.freeze({ ...manifest.installer }) });
}

async function verifyInstaller(file, manifest) {
  if (!manifest || !file) throw new Error("No verified ARM64 installer is available");
  const stat = await fs.promises.stat(file);
  if (stat.size !== manifest.installer.size) throw new Error("ARM64 installer size mismatch");
  const hash = crypto.createHash("sha512");
  for await (const chunk of fs.createReadStream(file)) hash.update(chunk);
  if (hash.digest("base64") !== manifest.installer.sha512) {
    throw new Error("ARM64 installer checksum mismatch");
  }
}

module.exports = { REPOSITORY, APP_ID, assetUrl, verifyManifest, verifyInstaller };
