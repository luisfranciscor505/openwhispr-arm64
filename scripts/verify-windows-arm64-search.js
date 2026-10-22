const { app } = require("electron");
const fs = require("fs");
const os = require("os");
const path = require("path");
const assert = require("assert/strict");
const root = path.resolve(__dirname, "..");
const testHome = fs.mkdtempSync(path.join(os.tmpdir(), "ow-arm64-search-"));
const originalHome = os.homedir;
os.homedir = () => testHome;
const QdrantManager = require("../src/helpers/qdrantManager");
os.homedir = originalHome;
const qdrant = new QdrantManager();
qdrant.getBinaryPath = () =>
  path.join(
    process.env.LOCALAPPDATA,
    "Programs",
    "OpenWhispr",
    "resources",
    "bin",
    "qdrant-win32-arm64.exe"
  );
const embeddings = require("../src/helpers/localEmbeddings");
const report = { date: new Date().toISOString(), arch: process.arch };

async function verify() {
  try {
    await qdrant.start();
    async function request(route, method, body) {
      const response = await fetch(`http://127.0.0.1:${qdrant.port}${route}`, {
        method,
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      assert.ok(response.ok, await response.clone().text());
      return response.json();
    }
    const texts = [
      "A doctor treats patients at a hospital.",
      "The kitten sleeps on a warm blanket.",
      "The compiler builds native Windows ARM64 executables.",
    ];
    const vectors = [];
    for (const text of texts) vectors.push(Array.from(await embeddings.embedText(text)));
    await request("/collections/arm64_verify", "PUT", {
      vectors: { size: 384, distance: "Cosine" },
    });
    await request("/collections/arm64_verify/points?wait=true", "PUT", {
      points: texts.map((text, i) => ({ id: i + 1, vector: vectors[i], payload: { text } })),
    });
    const query = Array.from(await embeddings.embedText("medical care for sick people"));
    report.query = "medical care for sick people";
    report.results = (
      await request("/collections/arm64_verify/points/query", "POST", {
        query,
        limit: 3,
        with_payload: true,
      })
    ).result.points;
    assert.equal(report.results[0].id, 1);
    report.success = true;
  } catch (error) {
    report.success = false;
    report.error = error.stack;
    throw error;
  } finally {
    await qdrant.stop();
    await embeddings.unload();
    await require("../src/helpers/onnxWorkerClient").stop();
    fs.writeFileSync(
      path.join(root, "artifacts", "windows-arm64", "search-verification.json"),
      JSON.stringify(report, null, 2)
    );
  }
}
app
  .whenReady()
  .then(verify)
  .then(
    () => app.exit(0),
    (error) => {
      console.error(error);
      app.exit(1);
    }
  );
