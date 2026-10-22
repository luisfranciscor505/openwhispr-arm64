function createUpdateActivity(isInstalling) {
  let active = 0;
  return {
    isBusy: () => active > 0,
    wrap:
      (operation) =>
      async (...args) => {
        if (isInstalling()) return { success: false, error: "Update installation in progress" };
        active++;
        try {
          return await operation(...args);
        } finally {
          active--;
        }
      },
  };
}
module.exports = { createUpdateActivity };
