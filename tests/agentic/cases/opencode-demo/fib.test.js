import assert from "node:assert";
import { fibonacci } from "./fib.js";

assert.strictEqual(fibonacci(0), 0);
assert.strictEqual(fibonacci(1), 1);
assert.strictEqual(fibonacci(10), 55);

console.log("All fib tests passed");
