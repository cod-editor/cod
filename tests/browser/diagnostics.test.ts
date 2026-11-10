import { test } from "node:test";
import assert from "node:assert/strict";
import {
  DiagnosticCapture,
  diagnosticRoute,
} from "../../src/browser/diagnostics.ts";
const secret = "PRIVATE_SENTINEL";
const route = "https://auth.cloud.yandex.ru/oauth/authorize";
test("only exact public routes survive credential, query and path sanitization", () => {
  assert.equal(diagnosticRoute(`${route}?code=${secret}#${secret}`), route);
  for (const url of [
    `https://${secret}@auth.cloud.yandex.ru/oauth/authorize`,
    `${route}/${secret}`,
    `https://tracker.yandex.ru/issues/${secret}`,
    `https://auth.cloud.yandex.ru:8443/oauth/authorize`,
    `http://auth.cloud.yandex.ru/oauth/authorize`,
  ])
    assert.equal(diagnosticRoute(url), undefined);
});
test("capture strips payloads and exposes only finite metadata", () => {
  let now = 0;
  const capture = new DiagnosticCapture(() => now);
  const request = {
    requestId: secret,
    type: "Document",
    request: {
      url: `${route}?state=${secret}`,
      headers: { cookie: secret },
      postData: secret,
    },
  };
  capture.accept("Network.requestWillBeSent", request);
  now = 10;
  capture.accept("Network.requestWillBeSent", {
    ...request,
    redirectResponse: {
      url: `${route}?state=${secret}`,
      status: 307,
      headers: { location: secret },
      statusText: secret,
    },
  });
  capture.accept("Network.responseReceivedExtraInfo", {
    requestId: secret,
    headers: { "set-cookie": secret },
    blockedCookies: [
      {
        cookie: { name: secret, value: secret },
        blockedReasons: [secret, "SecureOnly"],
      },
    ],
  });
  capture.accept("Network.responseReceived", {
    requestId: secret,
    response: {
      url: `${route}?token=${secret}`,
      status: 200,
      protocol: secret,
      headers: { secret },
      body: secret,
    },
  });
  capture.accept("Network.loadingFailed", {
    requestId: secret,
    errorText: `net::ERR_${secret}`,
  });
  const report = capture.read();
  assert.ok(!JSON.stringify(report).includes(secret));
  assert.equal(report.events[1].repeated, true);
  assert.deepEqual(report.events[3].reasons, ["Other", "SecureOnly"]);
  assert.equal(report.events.at(-1)?.error, "NETWORK_ERROR");
  const before = report.events.length;
  capture.accept("Network.requestWillBeSent", {
    ...request,
    request: { url: `https://tracker.yandex.ru/issues/${secret}` },
  });
  assert.equal(capture.read().events.length, before);
});
test("capture expires at45seconds and stops at200events", () => {
  let now = 1;
  const expired = new DiagnosticCapture(() => now);
  now = 45001;
  expired.accept("Network.requestWillBeSent", {
    requestId: "1",
    type: "Document",
    request: { url: route },
  });
  assert.equal(expired.read().state, "expired");
  assert.equal(expired.read().events.length, 0);
  const limited = new DiagnosticCapture(() => now);
  for (let i = 0; i < 250; i++)
    limited.accept("Network.requestWillBeSent", {
      requestId: String(i),
      type: "Document",
      request: { url: route },
    });
  assert.equal(limited.read().state, "limit");
  assert.equal(limited.read().events.length, 200);
});
