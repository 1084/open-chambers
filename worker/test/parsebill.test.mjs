import { test } from "node:test";
import assert from "node:assert/strict";
import { parseBill } from "../src/index.mjs";
test("parseBill", () => {
  assert.deepEqual(parseBill("H R 4210"), { type: "hr", number: 4210 });
  assert.deepEqual(parseBill("S. 99"), { type: "s", number: 99 });
  assert.deepEqual(parseBill("H J RES 12"), { type: "hjres", number: 12 });
  assert.equal(parseBill("QUORUM"), null);
});
