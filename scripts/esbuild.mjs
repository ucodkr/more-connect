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
mkdirSync("media", { recursive: true });

/** @type {import("esbuild").BuildOptions} */
const extensionBuildOptions = {
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

/** @type {import("esbuild").BuildOptions} */
const webviewBuildOptions = {
  bundle: true,
  sourcemap: true,
  minify: false,
  logLevel: "info",
  platform: "browser",
  target: ["es2020"],
  format: "iife",
  entryPoints: [
    "src/webview/connectionWizardApp.tsx",
    "src/webview/dockerLogsApp.tsx",
    "src/webview/resultsApp.tsx",
    "src/webview/sshExplorerApp.tsx",
    "src/webview/infoPanelApp.tsx"
  ],
  outdir: "media",
  entryNames: "[name]",
  loader: {
    ".ts": "ts",
    ".tsx": "tsx"
  }
};

if (watch) {
  const extensionCtx = await esbuild.context(extensionBuildOptions);
  const webviewCtx = await esbuild.context(webviewBuildOptions);
  await extensionCtx.watch();
  await webviewCtx.watch();
  await esbuild.build(extensionBuildOptions);
  await esbuild.build(webviewBuildOptions);
  console.log("Watching: extension (src/extension.ts → dist/extension.js)");
  console.log("Watching: webviews (src/webview/*.tsx → media/*.js)");
} else {
  await esbuild.build(extensionBuildOptions);
  await esbuild.build(webviewBuildOptions);
  console.log("Built.");
}
