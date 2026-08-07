import assert from "node:assert";
import { md2html } from "./md2html.js";

assert.strictEqual(md2html("# Title"), "<h1>Title</h1>");
assert.strictEqual(md2html("## Sub"), "<h2>Sub</h2>");
assert.strictEqual(md2html("### Sub3"), "<h3>Sub3</h3>");
assert.strictEqual(md2html("hello world"), "<p>hello world</p>");
assert.strictEqual(
  md2html("- one\n- two"),
  "<ul>\n<li>one</li>\n<li>two</li>\n</ul>"
);
assert.strictEqual(md2html("Use `code` now"), "<p>Use <code>code</code> now</p>");
assert.strictEqual(
  md2html("```\nlet x = 1;\n```"),
  "<pre><code>\nlet x = 1;\n</code></pre>"
);
assert.strictEqual(
  md2html("[opencode](https://opencode.ai)"),
  '<p><a href="https://opencode.ai">opencode</a></p>'
);
assert.strictEqual(md2html("a < b & c"), "<p>a &lt; b &amp; c</p>");
assert.strictEqual(
  md2html("**bold** text"),
  "<p><strong>bold</strong> text</p>"
);

console.log("test.js: all 10 assertions passed");
