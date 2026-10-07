import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { vertexConfigIssue } from "../src/vertex-config.ts";

const schema = JSON.parse(readFileSync(new URL("../../contracts/provider.schema.json", import.meta.url), "utf8"));
test("provider contract describes every persisted field and excludes credential values from Vertex", () => {
  assert.deepEqual(Object.keys(schema.properties).sort(), ["cliTextBridge", "cursor", "kimi", "budget", "vertex", "id", "name", "baseUrl", "defaultModel", "models", "protocols", "modelProtocols", "route", "routePinned", "messagesRoute", "healthMonitor", "anthropicBaseUrl", "streamUsage", "reasoningEffort", "modelEfforts", "antigravity", "kiro", "mimoFree", "probe", "off", "plan", "billing", "prices", "icon", "urlParams", "wire", "keys", "createdAt"].sort());
  assert.equal(schema.additionalProperties, false);
  assert.equal(schema.properties.off.type, "boolean");
  assert.equal(schema.properties.protocols.$ref, "#/$defs/protocols");
  assert.deepEqual(schema.$defs.protocols.items.enum, ["chat", "responses", "messages", "gemini"]);
  for (const variant of schema.properties.vertex.oneOf) {
    assert.equal(variant.additionalProperties, false);
    assert.ok(!("token" in variant.properties) && !("apiKey" in variant.properties));
  }
});
test("Vertex contract identifier constraints match the actual adapter validator", () => {
  const properties = schema.properties.vertex.oneOf[0].properties;
  const projectPattern = new RegExp(properties.project.pattern), locationPattern = new RegExp(properties.location.pattern);
  for (const project of ["example-project", "123456789012", "x", "a/../../b", "A-big-project"]) {
    assert.equal(projectPattern.test(project), vertexConfigIssue({ mode: "standard", auth: "access-token", project, location: "global" }) === undefined, project);
  }
  for (const location of ["global", "us-central1", "europe-west12", "https://bad.invalid", "bad"]) {
    assert.equal(locationPattern.test(location), vertexConfigIssue({ mode: "standard", auth: "access-token", project: "example-project", location }) === undefined, location);
  }
});
