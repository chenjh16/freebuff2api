import { readFileSync } from "node:fs";
import { md2html } from "./md2html.js";

const file = process.argv[2];
if (!file) {
  console.error("Usage: node cli.js <file.md>");
  process.exit(1);
}

const src = readFileSync(file, "utf8");
process.stdout.write(md2html(src) + "\n");
