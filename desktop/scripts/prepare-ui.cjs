// Copies the built dashboard (ui/dist) into desktop/ui-dist so electron-builder
// packages it with the app. Builds the UI first when it has not been built.
//
//   node scripts/prepare-ui.cjs            copy, building if needed
//   node scripts/prepare-ui.cjs --force    rebuild the UI first
const { spawnSync } = require("child_process");
const fs = require("fs");
const path = require("path");

const root = path.resolve(__dirname, "..", "..");
const uiDir = path.join(root, "ui");
const src = path.join(uiDir, "dist");
const dest = path.resolve(__dirname, "..", "ui-dist");
const force = process.argv.includes("--force");

function run(cmd, args, cwd) {
  const res = spawnSync(cmd, args, { cwd, stdio: "inherit", shell: process.platform === "win32" });
  if (res.status !== 0) {
    console.error(`${cmd} ${args.join(" ")} failed in ${cwd}`);
    process.exit(res.status || 1);
  }
}

if (force || !fs.existsSync(path.join(src, "index.html"))) {
  if (!fs.existsSync(path.join(uiDir, "node_modules"))) run("npm", ["ci", "--no-audit", "--no-fund"], uiDir);
  run("npm", ["run", "build"], uiDir);
}

fs.rmSync(dest, { recursive: true, force: true });
fs.cpSync(src, dest, { recursive: true });
const files = fs.readdirSync(path.join(dest, "assets")).length;
console.log(`ui-dist ready: index.html + ${files} assets from ${path.relative(root, src)}`);
