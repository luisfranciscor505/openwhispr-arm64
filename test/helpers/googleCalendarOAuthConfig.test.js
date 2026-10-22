const test = require("node:test");
const assert = require("node:assert/strict");
const Module = require("node:module");

test("missing Google client fails before opening a browser or starting OAuth", () => {
  const originalLoad = Module._load;
  let opened = false;
  Module._load = function (request, parent, isMain) {
    if (request === "electron") return { net: {} };
    if (request === "./oauthLoopbackFlow")
      return {
        runOAuthLoopbackFlow: () => {
          opened = true;
        },
      };
    return originalLoad.call(this, request, parent, isMain);
  };
  let GoogleCalendarOAuth;
  try {
    GoogleCalendarOAuth = require("../../src/helpers/googleCalendarOAuth");
  } finally {
    Module._load = originalLoad;
  }
  const oauth = new GoogleCalendarOAuth({});
  for (const [id, secret] of [
    [undefined, undefined],
    ["id", ""],
    [" ", "secret"],
  ]) {
    oauth.getClientId = () => id;
    oauth.getClientSecret = () => secret;
    assert.throws(() => oauth.startOAuthFlow(), { code: "google_calendar_not_configured" });
    assert.equal(opened, false);
  }
  oauth.getClientId = () => "id";
  oauth.getClientSecret = () => "secret";
  oauth.startOAuthFlow();
  assert.equal(opened, true);
});
