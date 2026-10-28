#!/usr/bin/env node
// OPTIONAL build step.
//
// The published app needs NO Node.js: static/ ships as plain ES modules and the
// Python server serves them directly. Run this only if you want a bundled,
// minified single-file build (fewer requests, faster cold start).
//
//   npm i -D esbuild && node build_frontend.mjs
//
import { build } from "esbuild";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";

const OUT = "static/dist";
const CSS_FILES = ["static/css/tokens.css", "static/css/app.css", "static/css/reader.css"];

async function main() {
  if (!existsSync("node_modules/esbuild")) {
    console.error("esbuild not installed. Run: npm i -D esbuild");
    process.exit(1);
  }
  await mkdir(OUT, { recursive: true });

  await build({
    entryPoints: ["static/js/app.js"],
    bundle: true,
    minify: true,
    format: "esm",
    target: ["es2020"],
    outfile: OUT + "/app.js",
    legalComments: "none",
  });

  const cssParts = [];
  for (const file of CSS_FILES) cssParts.push(await readFile(file, "utf8"));
  await writeFile(OUT + "/app.css", cssParts.join("\n"));

  let html = await readFile("static/index.html", "utf8");
  [
    ["/css/tokens.css", "/dist/app.css"],
    ["/css/app.css", "/dist/app.css"],
    ["/css/reader.css", "/dist/app.css"],
    ["/js/app.js", "/dist/app.js"],
  ].forEach(([from, to]) => {
    html = html.split(from).join(to);
  });
  await writeFile(OUT + "/index.html", html);

  console.log("Built", OUT + "/app.js", "- point the server at static/dist to use it.");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
