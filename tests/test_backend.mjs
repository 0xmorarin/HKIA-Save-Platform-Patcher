import fs from "node:fs";
import assert from "node:assert/strict";
import path from "node:path";
import { pathToFileURL } from "node:url";

const repo = process.cwd();
const { parseSave, patchSavePlatform } = await import(pathToFileURL(path.join(repo, "parser.js")));
const files = process.argv.slice(2);
if (!files.length) {
  console.error("Usage: node test_backend.mjs <path/to/save_0.save> [other saves ...]");
  process.exit(2);
}

let tested = 0;
for (const name of files) {
  const input = new Uint8Array(fs.readFileSync(name));
  const info = parseSave(input);
  assert.ok([1, 4, 5, 6, 7, 9, 10, 12].includes(info.platformType), `Unexpected source platform in ${name}`);
  const group = (v) => ([4, 5, 6, 7].includes(v) ? "apple" : String(v));
  const destinations = [1, 7, 9, 10].filter((id) => group(id) !== group(info.platformType));

  for (const target of destinations) {
    const changed = patchSavePlatform(input, target);
    assert.equal(parseSave(changed.bytes).platformType, target);
    assert.equal(changed.after.applicationVersion, info.applicationVersion);
    assert.equal(changed.after.timePlayedTicks, info.timePlayedTicks);
    assert.equal(changed.bytes.length, input.length);
    for (let i = 0; i < input.length; i++) {
      if (i >= info.platformOffset && i < info.platformOffset + info.platformTokenLength) continue;
      assert.equal(changed.bytes[i], input[i], `Unexpected change at file offset ${i} in ${name}`);
    }
    tested++;
  }
  for (const forbidden of [0, 12, 99]) {
    assert.throws(() => patchSavePlatform(input, forbidden), `Unknown/unverified target ${forbidden} should fail`);
    tested++;
  }
  assert.throws(() => patchSavePlatform(input, info.platformType), "Same-group conversion should fail");
  tested++;
  console.log(`PASS ${path.basename(name)}: source=${info.platformType}, version=${info.applicationVersion}, conversions=${destinations.join(",")}`);
}
console.log(`PASS ${tested} offline backend assertions. This is not a hardware/game-load test.`);
