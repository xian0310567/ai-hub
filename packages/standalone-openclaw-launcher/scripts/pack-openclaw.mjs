#!/usr/bin/env node
// Packs ../standalone-openclaw into a tarball and writes it to
// src-tauri/resources/standalone-openclaw.tgz so Tauri bundles it as a
// launcher resource. bootstrap.rs then runs `npm install` against this local
// tarball instead of the public npm registry (where the package isn't
// published).
//
// Caching: if the tarball already exists we skip the pack by default. Pass
// --force (or set PACK_OPENCLAW_FORCE=1) to force a repack — useful after
// editing standalone-openclaw source during dev.
//
// CI: workflows run on a fresh checkout with no cached tarball, so pack
// always runs there without any extra wiring.

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, renameSync, rmSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// On Windows, npm/pnpm ship as `.cmd` shims. Node 20+ refuses to execute
// `.cmd`/`.bat` via execFileSync without `shell: true` (CVE-2024-27980
// mitigation — EINVAL otherwise). Using shell:true on Windows routes through
// cmd.exe which handles both PATHEXT resolution and the security check.
const IS_WIN = process.platform === "win32";
const SPAWN_OPTS = { stdio: "inherit", shell: IS_WIN };

const here = dirname(fileURLToPath(import.meta.url));
const launcherRoot = resolve(here, "..");
const packageRoot = resolve(launcherRoot, "../standalone-openclaw");
const resourcesDir = resolve(launcherRoot, "src-tauri/resources");
const targetTarball = join(resourcesDir, "standalone-openclaw.tgz");

const force =
  process.argv.includes("--force") || process.env.PACK_OPENCLAW_FORCE === "1";

mkdirSync(resourcesDir, { recursive: true });

if (existsSync(targetTarball) && !force) {
  console.log(
    `[pack-openclaw] ${targetTarball} already exists — skipping (use --force to repack)`
  );
  process.exit(0);
}

// Remove stale versioned tarballs left behind by prior packs.
for (const name of readdirSync(resourcesDir)) {
  if (name.startsWith("standalone-openclaw-") && name.endsWith(".tgz")) {
    rmSync(join(resourcesDir, name));
  }
}
if (existsSync(targetTarball)) {
  rmSync(targetTarball);
}

// standalone-openclaw is excluded from the root pnpm workspace and ships its
// own lockfile. Auto-install if node_modules is missing so fresh clones
// (CI, first-time dev) work without a separate bootstrap step.
if (!existsSync(join(packageRoot, "node_modules"))) {
  console.log(`[pack-openclaw] installing deps in ${packageRoot}`);
  // --ignore-workspace: standalone-openclaw is explicitly excluded from the
  // root pnpm-workspace.yaml and owns its own pnpm-lock.yaml, so we install
  // it as a standalone project.
  execFileSync(
    "pnpm",
    ["install", "--ignore-workspace", "--frozen-lockfile"],
    { cwd: packageRoot, ...SPAWN_OPTS }
  );
}

// Build dist/ and dist/control-ui/ ourselves instead of letting `npm pack`'s
// prepack script do it. The upstream `scripts/openclaw-prepack.ts` spawns
// `pnpm.cmd` via spawnSync without `shell: true`, which trips Node's
// CVE-2024-27980 guard on Windows (EINVAL), and its error handler silently
// swallows the failure — the outer `npm pack` just exits 1 with no log.
// Running the builds here via our shell-safe spawn avoids that, then we pack
// with --ignore-scripts to skip the broken prepack entirely.
console.log(`[pack-openclaw] building ${packageRoot} (pnpm build)`);
execFileSync("pnpm", ["build"], { cwd: packageRoot, ...SPAWN_OPTS });
console.log(`[pack-openclaw] building control UI (pnpm ui:build)`);
execFileSync("pnpm", ["ui:build"], { cwd: packageRoot, ...SPAWN_OPTS });

console.log(`[pack-openclaw] packing ${packageRoot}`);
// --ignore-scripts: skip prepack/prepare/postpack. We've already prepared
// dist/ and dist/control-ui/ above; running the prepack again would only
// rebuild them (slow) or fail on Windows due to the upstream bug noted above.
execFileSync(
  "npm",
  ["pack", "--ignore-scripts", "--pack-destination", resourcesDir],
  { cwd: packageRoot, ...SPAWN_OPTS }
);

const packed = readdirSync(resourcesDir).find(
  (name) => name.startsWith("standalone-openclaw-") && name.endsWith(".tgz")
);
if (!packed) {
  throw new Error(
    `npm pack did not produce a standalone-openclaw-*.tgz in ${resourcesDir}`
  );
}

const packedPath = join(resourcesDir, packed);
renameSync(packedPath, targetTarball);
console.log(`[pack-openclaw] wrote ${targetTarball}`);
