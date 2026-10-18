import assert from "node:assert/strict";
import { test } from "node:test";
import { CustomToolInput } from "../src/custom-tool-input.ts";

for (const input of ["", "plain", '你好😀\n\r\t\b\f"\\/', '\ud83d\ude00x', '\ud800x', 'x\udc00', '\ud800']) {
  test(`custom decoder survives every two-fragment boundary: ${JSON.stringify(input)}`, () => {
    for (const escaped of [false, true]) {
      const raw = JSON.stringify({ input }).replace(/[\u007f-\uffff]/g, c => escaped ? '\\u' + c.charCodeAt(0).toString(16).padStart(4, '0') : c);
      for (let at = 0; at <= raw.length; at++) {
        const decoder = new CustomToolInput();
        const result = decoder.add(raw.slice(0, at)) + decoder.add(raw.slice(at));
        decoder.validate(raw); assert.equal(result, input);
      }
    }
  });
}

for (const raw of ['{"input":"\\uZZZZ"}', '{"input":"\\q"}', '{"input":"literal\n"}']) test(`custom decoder rejects invalid escapes/control bytes: ${JSON.stringify(raw)}`, () => {
  assert.throws(() => { const decoder = new CustomToolInput(); for (const char of raw) decoder.add(char); });
});

test("custom decoder rejects escaped duplicate input property names", () => {
  const raw = '{"input":"first","\\u0069nput":"first more"}';
  const decoder = new CustomToolInput(); assert.equal(decoder.add(raw), "first");
  assert.throws(() => decoder.validate(raw));
});
