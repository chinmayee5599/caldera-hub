import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHub } from "../dist/server.js";

// Resend allows 10 requests a second: a burst is spaced out, and a 429 waits and retries instead of dropping the email
test("email sends are throttled and retried on 429", async () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "caldera-send-"));
  const real = globalThis.fetch, hits = []; let n = 0;
  globalThis.fetch = async (url, init) => {
    if (String(url).startsWith("https://api.resend.com/")) { hits.push(Date.now()); n++;
      return n === 2 ? new Response('{"name":"rate_limit_exceeded"}', { status: 429, headers: { "retry-after": "0" } }) : new Response("{}", { status: 200 }); }
    return real(url, init);
  };
  const hub = createHub({ dataDir: d, publicUrl: "http://hub.test", email: { resendKey: "re_test" } });
  try {
    const sent = await Promise.all(Array.from({ length: 12 }, (_, i) => hub.mail.note({ to: `p${i}@example.com`, subject: "Hi", title: "Hi", html: "<p>x</p>", text: "x" })));
    assert.deepEqual(sent, Array(12).fill(true), "every email goes out, the rate-limited one included");
    assert.equal(hits.length, 13, "12 emails plus one retry");
    const gaps = hits.slice(1).map((t, i) => t - hits[i]);
    assert.ok(Math.min(...gaps) >= 110, `spaced out (min gap ${Math.min(...gaps)}ms)`);
    const perSecond = Math.max(...hits.map(t => hits.filter(x => x >= t && x < t + 1000).length));
    assert.ok(perSecond <= 9, `at most 9 a second (saw ${perSecond})`);
  } finally { globalThis.fetch = real; hub.server.close(); fs.rmSync(d, { recursive: true, force: true }); }
});
