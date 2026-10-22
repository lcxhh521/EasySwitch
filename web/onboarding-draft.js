/* A short-lived, unverified choice hint for a refresh in the same browser tab.
 * Not proof of a provider, account or service identity, a successful test/save,
 * or authorization for any API action. The caller must re-check current choices
 * and obtain explicit confirmation. Closing/reopening a tab is not guaranteed.
 * No secrets, persistent storage, backend requests or automatic actions belong here.
 */
(() => {
  "use strict";
  const key = "easyswitch:first-run:draft:v1";
  const ttlMs = 30 * 60 * 1000;
  const maxBytes = 2048;
  const inputFields = ["providerId", "model", "agent", "phase"];
  const recordFields = ["schema", "updatedAt", ...inputFields];

  // Snapshot data properties, not arbitrary objects or serializers. This also
  // accepts ordinary records from another realm and null-prototype records.
  function snapshot(value, fields) {
    if (!value || typeof value !== "object" || Array.isArray(value)) return null;
    const proto = Object.getPrototypeOf(value);
    if (proto !== null) {
      const constructor = Object.getOwnPropertyDescriptor(proto, "constructor");
      if (Object.getPrototypeOf(proto) !== null || !constructor
        || typeof constructor.value !== "function" || constructor.value.prototype !== proto) return null;
    }
    const descriptors = Object.getOwnPropertyDescriptors(value);
    const names = Reflect.ownKeys(descriptors);
    if (names.length !== fields.length || names.some(name => !fields.includes(name))) return null;
    const copy = Object.create(null);
    for (const name of fields) {
      const descriptor = descriptors[name];
      if (!descriptor || !Object.hasOwn(descriptor, "value")) return null;
      copy[name] = descriptor.value;
    }
    return copy;
  }

  function validString(value, limit) {
    return typeof value === "string" && value.length <= limit
      && value.trim() === value && !/[\x00-\x1f\x7f]/.test(value);
  }

  function withinByteLimit(serialized) {
    // The fast character check avoids encoding arbitrarily large stored strings.
    return serialized.length <= maxBytes && new TextEncoder().encode(serialized).length <= maxBytes;
  }

  function validate(record, now = Date.now()) {
    try {
      if (!Number.isSafeInteger(now)) return null;
      const value = snapshot(record, recordFields);
      if (!value || value.schema !== 1 || !Number.isSafeInteger(value.updatedAt)
        || value.updatedAt > now || now - value.updatedAt >= ttlMs) return null;
      if (!validString(value.providerId, 256) || !validString(value.model, 512)
        || !validString(value.agent, 128)) return null;
      if (!["source", "select", "launch-uncertain"].includes(value.phase)
        || (value.phase !== "source" && !value.providerId)) return null;
      const copy = { schema: 1, updatedAt: value.updatedAt, providerId: value.providerId,
        model: value.model, agent: value.agent, phase: value.phase };
      return withinByteLimit(JSON.stringify(copy)) ? copy : null;
    } catch { return null; }
  }

  function clear() {
    try {
      globalThis.sessionStorage.removeItem(key);
      return true;
    } catch { return false; }
  }

  function read(now = Date.now()) {
    try {
      if (!Number.isSafeInteger(now)) { clear(); return null; }
      const serialized = globalThis.sessionStorage.getItem(key);
      if (serialized === null) return null;
      if (typeof serialized !== "string" || !withinByteLimit(serialized)) { clear(); return null; }
      const record = validate(JSON.parse(serialized), now);
      if (!record) clear();
      return record;
    } catch { clear(); return null; }
  }

  function write(input, now = Date.now()) {
    try {
      const value = snapshot(input, inputFields);
      const record = value && validate({ schema: 1, updatedAt: now, providerId: value.providerId,
        model: value.model, agent: value.agent, phase: value.phase }, now);
      if (!record) { clear(); return false; }
      globalThis.sessionStorage.setItem(key, JSON.stringify(record));
      return true;
    } catch { clear(); return false; }
  }

  globalThis.EasySwitchFirstRunDraft = Object.freeze({ key, ttlMs, read, write, clear, validate });
})();
