let esbuild;
try {
  esbuild = await import("esbuild");
} catch (e) {
  console.error("esbuild not found. Run `npm i` (or `npm i -D esbuild`) and retry.");
  throw e;
}
import { execSync } from "node:child_process";
import { mkdirSync } from "node:fs";

const watch = process.argv.includes("--watch");

function getGitHash() {
  try {
    return execSync("git rev-parse --short HEAD", { stdio: ["ignore", "pipe", "ignore"] })
      .toString()
      .trim();
  } catch {
    return "dev";
  }
}

function getGitTag() {
  try {
    return execSync("git describe --tags --exact-match", { stdio: ["ignore", "pipe", "ignore"] })
      .toString()
      .trim();
  } catch {
    return "";
  }
}

mkdirSync("dist", { recursive: true });

/** @type {import("esbuild").BuildOptions} */
const buildOptions = {
  bundle: true,
  sourcemap: true,
  minify: false,
  logLevel: "info",
  platform: "node",
  target: ["node18"],
  entryPoints: ["src/extension.ts"],
  outfile: "dist/extension.js",
  format: "cjs",
  external: ["vscode"],
  define: {
    __MORE_CONNECT_BUILD_HASH__: JSON.stringify(getGitHash()),
    __MORE_CONNECT_BUILD_TAG__: JSON.stringify(getGitTag())
  }
};

if (watch) {
  const ctx = await esbuild.context(buildOptions);
  await ctx.watch();
  await esbuild.build(buildOptions);
  console.log("Watching: extension (src/extension.ts → dist/extension.js)");
} else {
  await esbuild.build(buildOptions);
  console.log("Built.");
}
