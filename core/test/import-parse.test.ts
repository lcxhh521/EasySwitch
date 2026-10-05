import assert from "node:assert/strict";
import { test } from "node:test";
import { nameFromUrl, parsePaste } from "../src/import-parse.ts";

test("a bare address and a bare key on one line", () => {
  const got = parsePaste("https://api.example.com/v1 sk-abc123def456ghi789jkl012mno345");
  assert.equal(got.baseUrl, "https://api.example.com/v1");
  assert.equal(got.apiKey, "sk-abc123def456ghi789jkl012mno345");
  assert.deepEqual(got.found, ["地址", "Key"]);
});

test("export snippets, Claude env JSON, and Chinese vendor prose", () => {
  assert.deepEqual(parsePaste("export OPENAI_BASE_URL=https://relay.foo.com/v1\nexport OPENAI_API_KEY=sk-xyz111222333444555666777888"), {
    baseUrl: "https://relay.foo.com/v1", apiKey: "sk-xyz111222333444555666777888", found: ["地址", "Key"],
  });
  assert.deepEqual(parsePaste('{"env":{"ANTHROPIC_BASE_URL":"https://cw.aaa.com","ANTHROPIC_AUTH_TOKEN":"tok-99887766554433221100ffeeddccbbaa"}}'), {
    baseUrl: "https://cw.aaa.com", apiKey: "tok-99887766554433221100ffeeddccbbaa", found: ["地址", "Key"],
  });
  assert.deepEqual(parsePaste("你的接口地址：https://one.bbb.cn/v1 ，令牌：sk-ccc111222333444555666777888999"), {
    baseUrl: "https://one.bbb.cn/v1", apiKey: "sk-ccc111222333444555666777888999", found: ["地址", "Key"],
  });
});

test("a tutorial doc: address and key come out; a docs link becomes the key page, not the endpoint", () => {
  const tutorial = "欢迎使用 XXX 中转站！\n1. 先注册：https://xxx.top/register 并创建令牌：https://xxx.top/token\nexport ANTHROPIC_BASE_URL=https://api.xxx.top\nexport ANTHROPIC_AUTH_TOKEN=sk-abc111222333444555666777888999";
  assert.deepEqual(parsePaste(tutorial), { baseUrl: "https://api.xxx.top", apiKey: "sk-abc111222333444555666777888999", found: ["地址", "Key"] });
  // Docs-only: nothing to add yet, but the key page is surfaced.
  const docsOnly = parsePaste("使用教程：https://docs.yyy.cn/start ，创建令牌后填密钥");
  assert.equal(docsOnly.baseUrl, undefined);
  assert.equal(docsOnly.keyUrl, "https://docs.yyy.cn/start");
  // Purchase page + endpoint + token page: the endpoint is the address, not /buy.
  const purchase = parsePaste("购买：https://zzz.com/buy ；接口地址 https://api.zzz.com/v1 ；令牌页 https://zzz.com/token");
  assert.equal(purchase.baseUrl, "https://api.zzz.com/v1");
  assert.equal(purchase.keyUrl, "https://zzz.com/token");
  assert.deepEqual(purchase.found, ["地址", "Key 的获取页面"]);
});

test("an official API address alone parses; prose with nothing parses to nothing", () => {
  assert.deepEqual(parsePaste("https://api.deepseek.com/v1"), { baseUrl: "https://api.deepseek.com/v1", found: ["地址"] });
  assert.deepEqual(parsePaste("随便一段话没有信息"), { found: [] });
});

test("display names come from the host", () => {
  assert.equal(nameFromUrl("https://api.aaa.com/v1"), "aaa 中转站");
  assert.equal(nameFromUrl("https://relay.foo.cn"), "relay 中转站");
  assert.equal(nameFromUrl("不是地址"), "新模型来源");
});
