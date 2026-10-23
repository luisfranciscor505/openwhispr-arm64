// Dependency-free: used before npm ci in the release workflow.
function changedNativeDependencies(before, after) {
  const entries = (lock) =>
    new Map(
      Object.entries(lock.packages || {})
        .filter(
          ([name, entry]) =>
            name &&
            (/(?:^|\/node_modules\/|^node_modules\/)(?:electron(?:-builder|-updater)?|better-sqlite3|onnxruntime(?:-node|-common)?|@napi-rs\/keyring(?:-win32-arm64-msvc)?)$/.test(
              name
            ) ||
              (entry.cpu?.includes("arm64") && entry.os?.includes("win32")))
        )
        .map(([name, entry]) => [
          name,
          JSON.stringify({
            version: entry.version,
            integrity: entry.integrity,
            resolved: entry.resolved,
          }),
        ])
    );
  const oldEntries = entries(before);
  const newEntries = entries(after);
  return [...new Set([...oldEntries.keys(), ...newEntries.keys()])].filter(
    (name) => oldEntries.get(name) !== newEntries.get(name)
  );
}

module.exports = { changedNativeDependencies };
