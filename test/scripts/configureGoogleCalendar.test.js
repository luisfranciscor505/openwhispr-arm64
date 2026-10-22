const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { configureGoogleCalendar } = require("../../scripts/configure-google-calendar");

test("imports desktop credentials without changing other app settings, and replaces old keys", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "calendar-config-"));
  try {
    const env = path.join(dir, ".env");
    const json = path.join(dir, "client.json");
    fs.writeFileSync(env, "# settings\nOTHER_KEY=keep\nGOOGLE_CALENDAR_CLIENT_ID=old\n");
    fs.writeFileSync(
      json,
      JSON.stringify({
        installed: {
          client_id: "test.apps.googleusercontent.com",
          client_secret: "test#secret",
        },
      })
    );
    configureGoogleCalendar(json, env);
    configureGoogleCalendar(json, env);
    const result = require("dotenv").parse(fs.readFileSync(env));
    assert.equal(result.OTHER_KEY, "keep");
    assert.equal(result.GOOGLE_CALENDAR_CLIENT_SECRET, "test#secret");
    assert.equal(
      (fs.readFileSync(env, "utf8").match(/GOOGLE_CALENDAR_CLIENT_ID=/g) || []).length,
      1
    );
    const before = fs.readFileSync(env, "utf8");
    fs.writeFileSync(json, JSON.stringify({ web: { client_id: "web" } }));
    assert.throws(() => configureGoogleCalendar(json, env), /Desktop app/);
    assert.equal(fs.readFileSync(env, "utf8"), before);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
