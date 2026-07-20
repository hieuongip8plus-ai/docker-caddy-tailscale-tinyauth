// tailscale/test/publish-state.test.mjs
// Unit tests cho idempotency cache của publish (tailscale/scripts/lib/publish-state.mjs).
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  computePublishHash,
  readPublishState,
  writePublishState,
  shouldSkipPublish,
  serveStatePresent,
} from "../scripts/lib/publish-state.mjs";

const cfgBase = {
  mode: "serve",
  serveStyle: "subdomain",
  autoApprove: true,
  tailnet: "tailnet.ts.net",
  nodeHost: "proxy-stack",
  doServe: true,
  doServices: false,
};
const services = [{ name: "whoami", upstream: "http://whoami:80" }];

test("computePublishHash: ổn định + đổi khi field đổi", () => {
  const h1 = computePublishHash({ cfg: cfgBase, services });
  const h2 = computePublishHash({ cfg: { ...cfgBase }, services: [{ ...services[0] }] });
  assert.equal(h1, h2, "cùng input → cùng hash");

  const h3 = computePublishHash({ cfg: { ...cfgBase, nodeHost: "other" }, services });
  assert.notEqual(h1, h3, "đổi nodeHost → hash đổi");

  const h4 = computePublishHash({ cfg: cfgBase, services: [{ name: "whoami", upstream: "http://whoami:8080" }] });
  assert.notEqual(h1, h4, "đổi upstream → hash đổi");
});

test("computePublishHash: thứ tự services/names không ảnh hưởng (canonical sort)", () => {
  const a = computePublishHash({ cfg: cfgBase, services: [{ name: "a", upstream: "u", names: ["y", "x"] }, { name: "b", upstream: "u2" }] });
  const b = computePublishHash({ cfg: cfgBase, services: [{ name: "b", upstream: "u2" }, { name: "a", upstream: "u", names: ["x", "y"] }] });
  assert.equal(a, b);
});

test("readPublishState: null nếu file thiếu/hỏng", () => {
  assert.equal(readPublishState("/khong/ton/tai.json"), null);
});

test("write + read round-trip", () => {
  const dir = mkdtempSync(join(tmpdir(), "pubstate-"));
  const file = join(dir, "published.json");
  try {
    assert.equal(writePublishState(file, { hash: "abc", mode: "serve" }), true);
    const st = readPublishState(file);
    assert.equal(st.hash, "abc");
    assert.ok(st.at, "có timestamp");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("shouldSkipPublish: no prevState → publish", () => {
  const d = shouldSkipPublish({ hash: "h", prevState: null, serveConfirmed: true, cfg: cfgBase });
  assert.equal(d.skip, false);
  assert.equal(d.reason, "no-previous-state");
});

test("shouldSkipPublish: hash khác → publish", () => {
  const d = shouldSkipPublish({ hash: "h", prevState: { hash: "OTHER" }, serveConfirmed: true, cfg: cfgBase });
  assert.equal(d.skip, false);
  assert.equal(d.reason, "config-hash-changed");
});

test("shouldSkipPublish: hash khớp + serve confirmed → SKIP", () => {
  const d = shouldSkipPublish({ hash: "h", prevState: { hash: "h" }, serveConfirmed: true, cfg: cfgBase });
  assert.equal(d.skip, true);
});

test("shouldSkipPublish: hash khớp NHƯNG serve state mất trên node → publish lại", () => {
  const d = shouldSkipPublish({ hash: "h", prevState: { hash: "h" }, serveConfirmed: false, cfg: cfgBase });
  assert.equal(d.skip, false);
  assert.equal(d.reason, "serve-state-missing-on-node");
});

test("shouldSkipPublish: doServe=false thì bỏ qua điều kiện serveConfirmed", () => {
  const cfg = { ...cfgBase, doServe: false, doServices: true };
  const d = shouldSkipPublish({ hash: "h", prevState: { hash: "h" }, serveConfirmed: false, cfg });
  assert.equal(d.skip, true);
});

test("serveStatePresent: true khi có TCP hoặc Web", () => {
  assert.equal(serveStatePresent(JSON.stringify({ TCP: { 443: { HTTPS: true } }, Web: {} })), true);
  assert.equal(serveStatePresent(JSON.stringify({ TCP: {}, Web: { "h:443": {} } })), true);
});

test("serveStatePresent: false khi rỗng / không parse được", () => {
  assert.equal(serveStatePresent(JSON.stringify({ TCP: {}, Web: {} })), false);
  assert.equal(serveStatePresent("not-json"), false);
  assert.equal(serveStatePresent(null), false);
});
