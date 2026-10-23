// Installed with administrator-only write access, outside the runner checkout.
const allowed =
  process.env.GITHUB_REPOSITORY === "luisfranciscor505/openwhispr-arm64" &&
  process.env.GITHUB_EVENT_NAME === "workflow_dispatch" &&
  process.env.GITHUB_REF === "refs/heads/arm64" &&
  process.env.GITHUB_WORKFLOW_REF ===
    "luisfranciscor505/openwhispr-arm64/.github/workflows/arm64-release.yml@refs/heads/arm64";
if (!allowed) {
  console.error(
    "This Snapdragon runner accepts only the maintained ARM64 release workflow, dispatched from arm64. Contributor PR jobs are refused before checkout."
  );
  process.exitCode = 1;
} else {
  console.log("Trusted ARM64 release workflow accepted by local runner policy.");
}
