const test = require("node:test");
const assert = require("node:assert/strict");
const { createUpdateActivity } = require("../../src/helpers/updateActivity");
test("tracks operations without request IDs, releases failed work, and blocks work during install", async () => {
  let installing = false,
    finish;
  const activity = createUpdateActivity(() => installing);
  const pending = activity.wrap(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      })
  )();
  assert.equal(activity.isBusy(), true);
  finish("done");
  assert.equal(await pending, "done");
  assert.equal(activity.isBusy(), false);
  await assert.rejects(
    activity.wrap(() => {
      throw new Error("failed");
    })(),
    /failed/
  );
  assert.equal(activity.isBusy(), false);
  installing = true;
  assert.equal(
    (
      await activity.wrap(() => {
        throw new Error("must not execute");
      })()
    ).success,
    false
  );
  assert.equal(activity.isBusy(), false);
});
