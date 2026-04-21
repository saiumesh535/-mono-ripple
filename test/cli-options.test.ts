import assert from "node:assert/strict";
import test from "node:test";
import {
  DEFAULT_PACKAGE_CUSTOM_BUILD,
  effectivePackageCustomBuild,
  packageCustomBuildCwd,
} from "../src/cli-options";

test("effectivePackageCustomBuild: missing entry → no hook", () => {
  assert.equal(effectivePackageCustomBuild(undefined), undefined);
});

test("effectivePackageCustomBuild: {} → default pnpm build", () => {
  assert.equal(effectivePackageCustomBuild({}), DEFAULT_PACKAGE_CUSTOM_BUILD);
  assert.equal(DEFAULT_PACKAGE_CUSTOM_BUILD, "pnpm run build");
});

test("effectivePackageCustomBuild: explicit customBuild wins", () => {
  assert.equal(
    effectivePackageCustomBuild({ customBuild: "pnpm --filter x run build" }),
    "pnpm --filter x run build",
  );
});

test("effectivePackageCustomBuild: blank string → no hook", () => {
  assert.equal(effectivePackageCustomBuild({ customBuild: "   " }), undefined);
});

test("packageCustomBuildCwd: default is dependency package root", () => {
  assert.equal(
    packageCustomBuildCwd({}, "/pkgs/a", "/repo"),
    "/pkgs/a",
  );
  assert.equal(
    packageCustomBuildCwd(undefined, "/pkgs/a", "/repo"),
    "/pkgs/a",
  );
});

test("packageCustomBuildCwd: workspace-root forces repo root", () => {
  assert.equal(
    packageCustomBuildCwd(
      { customBuildCwd: "workspace-root" },
      "/pkgs/a",
      "/repo",
    ),
    "/repo",
  );
});
