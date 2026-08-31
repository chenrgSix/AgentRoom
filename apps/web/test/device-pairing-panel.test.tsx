import assert from "node:assert/strict";
import test from "node:test";

import type {
  DevicePairingSessionCreated,
  DevicePairingSessionOwnerProjection
} from "@convene-wire/contracts/pairing-session";
import { JSDOM } from "jsdom";
import React from "react";

import {
  buildDevicePairingLink,
  createPairingOperationId,
  DevicePairingPanel
} from "../src/features/device/DevicePairingPanel.js";

const teamId = "team_pairingtest";
const pairingSessionId = "pairing_abcdefgh";
const created: DevicePairingSessionCreated = {
  createdAt: "2099-08-28T00:00:00.000Z",
  expiresAt: "2099-08-28T00:10:00.000Z",
  ownerMemberId: "member_owner123",
  pairingSessionId,
  shortCode: "ABCD-EFGH-JK",
  state: "issued",
  teamId
};
const privateTrust = {
  caCertificateSha256: "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
  installationId: "install_0123456789abcdefghijklmn",
  mode: "private_scoped_ca" as const,
  origin: "https://team.example.com",
  trustEpoch: 3
};
const privateCreated: DevicePairingSessionCreated = {
  ...created,
  trust: privateTrust
};

function projection(
  state: DevicePairingSessionOwnerProjection["state"],
  source = created
): DevicePairingSessionOwnerProjection {
  return {
    createdAt: created.createdAt,
    expiresAt: created.expiresAt,
    ownerMemberId: created.ownerMemberId,
    pairingSessionId,
    state,
    teamId,
    ...(source.memberBinding ? { memberBinding: source.memberBinding } : {}),
    ...(source.trust === undefined ? {} : { trust: source.trust }),
    ...(state === "claimed" || state === "approved" || state === "consumed"
      ? {
          claimedAt: "2099-08-28T00:01:00.000Z",
          pairingAttemptId: "pairattempt_abcdefgh",
          device: {
            bridgeVersion: "0.2.0-rc.3",
            displayName: "Alice Mac",
            platform: "darwin-arm64" as const,
            ...(source.trust === undefined ? {} : { supportsScopedPrivateTrust: true })
          }
        }
      : {}),
    ...(state === "claimed"
      ? { verificationPhrase: "LIME-RIVER-42" }
      : {}),
    ...(state === "approved" || state === "consumed"
      ? { decidedAt: "2099-08-28T00:02:00.000Z" }
      : {}),
    ...(state === "consumed"
      ? {
          consumedAt: "2099-08-28T00:03:00.000Z",
          deviceId: "device_abcdefgh"
        }
      : {})
  };
}

function jsonResponse(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    headers: { "content-type": "application/json" },
    status
  });
}

function installDom(): JSDOM {
  const dom = new JSDOM("<!doctype html><html><body></body></html>", {
    url: "https://team.example.com/"
  });
  Object.defineProperties(globalThis, {
    document: { configurable: true, value: dom.window.document },
    HTMLElement: { configurable: true, value: dom.window.HTMLElement },
    navigator: { configurable: true, value: dom.window.navigator },
    sessionStorage: { configurable: true, value: dom.window.sessionStorage },
    window: { configurable: true, value: dom.window }
  });
  Object.defineProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT", {
    configurable: true,
    value: true,
    writable: true
  });
  dom.window.sessionStorage.clear();
  return dom;
}

function pathOf(input: RequestInfo | URL): string {
  return typeof input === "string" ? input : input instanceof URL ? input.pathname : input.url;
}

test("pairing link keeps the browser proof in the fragment", () => {
  const link = buildDevicePairingLink(
    "https://team.example.com/ignored/path",
    created,
    "secret_abcdefghijklmnopqrstuvwxyz0123456789"
  );
  const parsed = new URL(link);
  assert.equal(parsed.protocol, "convenewire:");
  assert.equal(parsed.host, "pair-device");
  assert.equal(parsed.searchParams.get("origin"), "https://team.example.com");
  assert.equal(parsed.searchParams.get("pairingSessionId"), pairingSessionId);
  assert.equal(parsed.searchParams.get("expiresAt"), created.expiresAt);
  assert.equal(parsed.hash, "#claimSecret=secret_abcdefghijklmnopqrstuvwxyz0123456789");
  assert.equal(createPairingOperationId("12345678-abcd"), "op_12345678-abcd");
});

test("member pairing freezes the actual person and explicit Rooms into its recoverable intent", async () => {
  const dom = installDom();
  const originalFetch = globalThis.fetch;
  const binding = { displayName: "Bob", roomIds: ["room_selected123"] };
  const memberCreated = { ...created, memberBinding: binding };
  let requestBody: Record<string, unknown> | undefined;
  globalThis.fetch = async (input, init = {}) => {
    if ((init.method ?? "GET") === "POST" && pathOf(input).endsWith("/device-pairing-sessions")) {
      requestBody = JSON.parse(String(init.body)) as Record<string, unknown>;
      return jsonResponse(memberCreated);
    }
    return jsonResponse(projection("issued", memberCreated));
  };
  const { cleanup, render, within, fireEvent } = await import("@testing-library/react");
  try {
    render(<DevicePairingPanel currentMemberIsOwner currentMemberId={created.ownerMemberId} locale="zh-CN" teamId={teamId}
      members={[{ memberId: created.ownerMemberId, teamId, createdAt: created.createdAt, userId: "user_owner123", displayName: "Alice", role: "owner" }]}
      rooms={[{ roomId: "room_selected123", teamId, name: "Selected", settingsRevision: 1, createdAt: created.createdAt },
        { roomId: "room_private123", teamId, name: "Private", settingsRevision: 1, createdAt: created.createdAt }]}
      initialRoomId="room_selected123" />);
    const page = within(dom.window.document.body);
    assert.equal((page.getByRole("checkbox", { name: /同时确认成员归属/u }) as HTMLInputElement).checked, true);
    fireEvent.change(page.getByLabelText("客户端主人"), { target: { value: "new" } });
    assert.equal((page.getByRole("button", { name: "创建设备配对" }) as HTMLButtonElement).disabled, true);
    fireEvent.change(page.getByLabelText("成员姓名"), { target: { value: "Bob" } });
    fireEvent.click(page.getByRole("button", { name: "创建设备配对" }));
    await page.findByLabelText("一次性配对链接");
    assert.deepEqual(requestBody?.memberBinding, binding);
    assert.equal(page.queryByText(created.shortCode), null);
    const link = new URL((page.getByLabelText("一次性配对链接") as HTMLInputElement).value);
    assert.equal(new URLSearchParams(link.hash.slice(1)).get("memberAccess"), "1");
    assert.match(page.getByText(/确认主人：/u).textContent ?? "", /Bob/u);
    assert.equal(page.queryByLabelText("客户端主人"), null);
    const stored = Array.from({ length: sessionStorage.length }, (_, index) => sessionStorage.getItem(sessionStorage.key(index)!)).find((value) => value?.includes("memberBinding"));
    assert.ok(stored?.includes('"displayName":"Bob"'));
  } finally { cleanup(); globalThis.fetch = originalFetch; dom.window.close(); }
});

test("private pairing link preserves only the exact trust descriptor in its fragment", () => {
  const claimSecret = "secret_abcdefghijklmnopqrstuvwxyz0123456789";
  const link = buildDevicePairingLink(
    "https://team.example.com",
    privateCreated,
    claimSecret
  );
  const parsed = new URL(link);
  assert.equal(parsed.searchParams.get("origin"), privateTrust.origin);
  assert.doesNotMatch(parsed.search, /trust|install|sha256/iu);
  const fragment = new URLSearchParams(parsed.hash.slice(1));
  assert.deepEqual([...fragment.keys()].sort(), [
    "caCertificateSha256",
    "claimSecret",
    "installationId",
    "trustEpoch",
    "trustMode",
    "trustOrigin"
  ]);
  assert.equal(fragment.get("claimSecret"), claimSecret);
  assert.equal(fragment.get("trustMode"), privateTrust.mode);
  assert.equal(fragment.get("trustOrigin"), privateTrust.origin);
  assert.equal(fragment.get("installationId"), privateTrust.installationId);
  assert.equal(fragment.get("trustEpoch"), String(privateTrust.trustEpoch));
  assert.equal(fragment.get("caCertificateSha256"), privateTrust.caCertificateSha256);
  assert.throws(() => buildDevicePairingLink(
    privateTrust.origin,
    {
      ...privateCreated,
      trust: { ...privateTrust, origin: "https://other.example.com" }
    },
    claimSecret
  ), /trust descriptor is invalid/u);
});

test("private pairing explains Bridge-only trust, hides short code, and clears the descriptor", async () => {
  const dom = installDom();
  let current = projection("issued", privateCreated);
  globalThis.fetch = async (input, init = {}) => {
    const path = pathOf(input);
    if ((init.method ?? "GET") === "POST" && path.endsWith("/device-pairing-sessions")) {
      return jsonResponse(privateCreated);
    }
    if (path.endsWith("/cancel")) {
      current = projection("canceled", privateCreated);
      return jsonResponse(current);
    }
    return jsonResponse(current);
  };

  const { cleanup, fireEvent, render, within } = await import("@testing-library/react");
  try {
    render(
      <DevicePairingPanel
        currentMemberIsOwner
        currentMemberId={created.ownerMemberId}
        locale="zh-CN"
        sessionToken="session_owner"
        teamId={teamId}
      />
    );
    const page = within(dom.window.document.body);
    fireEvent.click(page.getByRole("button", { name: "创建设备配对" }));
    await page.findByText("Bridge 定向私有 CA");
    page.getByText(/无需在 Windows 或 macOS 安装 CA/u);
    page.getByText(/不适用于浏览器/u);
    page.getByText(/首次配对不提供短码入口/u);
    assert.equal(page.queryByText(privateCreated.shortCode), null);
    const link = page.getByLabelText("一次性配对链接") as HTMLInputElement;
    assert.equal(
      new URLSearchParams(new URL(link.value).hash.slice(1)).get("caCertificateSha256"),
      privateTrust.caCertificateSha256
    );
    const proofKey = `agent-room.device-pairing.${teamId}.${created.ownerMemberId}`;
    assert.match(globalThis.sessionStorage.getItem(proofKey) ?? "", /private_scoped_ca/u);
    fireEvent.click(page.getByRole("button", { name: "取消本次配对" }));
    await page.findByText(/本次配对已取消/u);
    assert.equal(globalThis.sessionStorage.getItem(proofKey), null);
    assert.doesNotMatch(dom.window.document.body.innerHTML, new RegExp(privateTrust.caCertificateSha256));
  } finally {
    cleanup();
    dom.window.close();
  }
});

test("non-Owners cannot see or invoke Device pairing controls", async () => {
  const dom = installDom();
  let fetched = false;
  globalThis.fetch = async () => {
    fetched = true;
    return jsonResponse({});
  };
  const { cleanup, render, within } = await import("@testing-library/react");
  try {
    render(
      <DevicePairingPanel
        currentMemberIsOwner={false}
        currentMemberId="member_viewer123"
        locale="zh-CN"
        sessionToken="session_member"
        teamId={teamId}
      />
    );
    assert.equal(within(dom.window.document.body).queryByText("连接一台 Device"), null);
    assert.equal(fetched, false);
  } finally {
    cleanup();
    dom.window.close();
  }
});

test("Owner creates, verifies, approves, and clears a consumed proof", async () => {
  const dom = installDom();
  let current = projection("issued");
  const posts: Array<{ path: string; body: Record<string, string>; headers: HeadersInit | undefined }> = [];
  globalThis.fetch = async (input, init = {}) => {
    const path = pathOf(input);
    if ((init.method ?? "GET") === "POST") {
      const body = JSON.parse(String(init.body)) as Record<string, string>;
      posts.push({ path, body, headers: init.headers });
      if (path.endsWith("/device-pairing-sessions")) return jsonResponse(created);
      if (path.endsWith("/approve")) {
        current = projection("consumed");
        return jsonResponse(current);
      }
      throw new Error(`Unexpected POST ${path}`);
    }
    assert.equal(path, `/api/teams/${teamId}/device-pairing-sessions/${pairingSessionId}`);
    return jsonResponse(current);
  };

  const { cleanup, fireEvent, render, within } = await import("@testing-library/react");
  try {
    render(
      <DevicePairingPanel
        currentMemberIsOwner
        currentMemberId={created.ownerMemberId}
        locale="zh-CN"
        sessionToken="session_owner"
        teamId={teamId}
      />
    );
    const page = within(dom.window.document.body);
    fireEvent.click(page.getByRole("button", { name: "创建设备配对" }));

    await page.findByText(created.shortCode);
    const qr = await page.findByAltText("Device 配对二维码") as HTMLImageElement;
    assert.match(qr.src, /^data:image\/svg\+xml/u);
    const link = page.getByLabelText("一次性配对链接") as HTMLInputElement;
    const createBody = posts[0]!.body;
    assert.deepEqual(Object.keys(createBody).sort(), ["claimSecret", "operationId"]);
    assert.match(createBody.claimSecret!, /^[A-Za-z0-9_-]{43}$/u);
    assert.match(createBody.operationId!, /^op_[A-Za-z0-9_-]{8,128}$/u);
    assert.equal(new URL(link.value).hash, `#claimSecret=${createBody.claimSecret}`);
    const proofKey = `agent-room.device-pairing.${teamId}.${created.ownerMemberId}`;
    assert.match(globalThis.sessionStorage.getItem(proofKey) ?? "", new RegExp(createBody.claimSecret!));
    assert.match(JSON.stringify(posts[0]!.headers), /Bearer session_owner/u);
    assert.doesNotMatch(JSON.stringify(created), /claimSecret|serverToken|credential|workspace|runtime/u);

    current = projection("claimed");
    fireEvent.click(page.getByRole("button", { name: "刷新配对状态" }));
    await page.findByText("LIME-RIVER-42");
    page.getByText("Alice Mac");
    page.getByText("darwin-arm64 · Bridge 0.2.0-rc.3");
    assert.equal(page.queryByLabelText("一次性配对链接"), null);

    const approve = page.getByRole("button", { name: "批准此 Device" }) as HTMLButtonElement;
    assert.equal(approve.disabled, true);
    fireEvent.click(page.getByLabelText("我已确认两边短语完全一致"));
    assert.equal(approve.disabled, false);
    fireEvent.click(approve);

    await page.findByText("Device 已安全配对；一次性证明已从此标签页清除。");
    assert.equal(globalThis.sessionStorage.getItem(proofKey), null);
    assert.doesNotMatch(dom.window.document.body.innerHTML, new RegExp(createBody.claimSecret!));
    assert.deepEqual(posts[1]!.body, {
      operationId: posts[1]!.body.operationId,
      expectedState: "claimed"
    });
    assert.match(posts[1]!.body.operationId!, /^op_[A-Za-z0-9_-]{8,128}$/u);
  } finally {
    cleanup();
    dom.window.close();
  }
});

test("ambiguous creation retries the exact browser-generated proof", async () => {
  const dom = installDom();
  const bodies: Array<Record<string, string>> = [];
  globalThis.fetch = async (_input, init = {}) => {
    const body = JSON.parse(String(init.body)) as Record<string, string>;
    bodies.push(body);
    if (bodies.length === 1) {
      return jsonResponse({ error: { message: "response lost" } }, 503);
    }
    return jsonResponse(created);
  };

  const { cleanup, fireEvent, render, within } = await import("@testing-library/react");
  try {
    const mounted = render(
      <DevicePairingPanel
        currentMemberIsOwner
        currentMemberId={created.ownerMemberId}
        locale="zh-CN"
        sessionToken={undefined}
        teamId={teamId}
      />
    );
    const page = within(dom.window.document.body);
    fireEvent.click(page.getByRole("button", { name: "创建设备配对" }));
    await page.findByRole("alert");
    mounted.unmount();
    render(
      <DevicePairingPanel
        currentMemberIsOwner
        currentMemberId={created.ownerMemberId}
        locale="zh-CN"
        sessionToken={undefined}
        teamId={teamId}
      />
    );
    fireEvent.click(page.getByRole("button", { name: "用同一证明重试创建" }));
    await page.findByText(created.shortCode);
    assert.equal(bodies.length, 2);
    assert.deepEqual(bodies[1], bodies[0]);
  } finally {
    cleanup();
    dom.window.close();
  }
});

test("a late create response cannot cross a Team scope change", async () => {
  const dom = installDom();
  let resolveCreate: ((response: Response) => void) | undefined;
  globalThis.fetch = async () => new Promise<Response>((resolve) => {
    resolveCreate = resolve;
  });

  const { act, cleanup, fireEvent, render, within } = await import("@testing-library/react");
  try {
    const mounted = render(
      <DevicePairingPanel
        currentMemberIsOwner
        currentMemberId={created.ownerMemberId}
        locale="zh-CN"
        sessionToken="session_owner"
        teamId={teamId}
      />
    );
    const page = within(dom.window.document.body);
    fireEvent.click(page.getByRole("button", { name: "创建设备配对" }));
    mounted.rerender(
      <DevicePairingPanel
        currentMemberIsOwner
        currentMemberId={created.ownerMemberId}
        locale="zh-CN"
        sessionToken="session_owner"
        teamId="team_pairingnext"
      />
    );
    await act(async () => {
      resolveCreate?.(jsonResponse(created));
      await Promise.resolve();
    });
    assert.equal(page.queryByText(created.shortCode), null);
    page.getByRole("button", { name: "创建设备配对" });
    assert.equal(globalThis.sessionStorage.getItem(
      `agent-room.device-pairing.team_pairingnext.${created.ownerMemberId}`
    ), null);
  } finally {
    cleanup();
    dom.window.close();
  }
});

test("ambiguous approval reconciles and retries one stable decision", async () => {
  const dom = installDom();
  let current = projection("claimed");
  let approveCount = 0;
  const approveBodies: Array<Record<string, string>> = [];
  globalThis.fetch = async (input, init = {}) => {
    const path = pathOf(input);
    if ((init.method ?? "GET") === "POST") {
      if (path.endsWith("/device-pairing-sessions")) return jsonResponse(created);
      if (path.endsWith("/approve")) {
        approveCount += 1;
        approveBodies.push(JSON.parse(String(init.body)) as Record<string, string>);
        if (approveCount === 1) {
          return jsonResponse({ error: { message: "approval response lost" } }, 503);
        }
        current = projection("consumed");
        return jsonResponse(current);
      }
    }
    return jsonResponse(current);
  };

  const { cleanup, fireEvent, render, within } = await import("@testing-library/react");
  try {
    render(
      <DevicePairingPanel
        currentMemberIsOwner
        currentMemberId={created.ownerMemberId}
        locale="zh-CN"
        sessionToken="session_owner"
        teamId={teamId}
      />
    );
    const page = within(dom.window.document.body);
    fireEvent.click(page.getByRole("button", { name: "创建设备配对" }));
    await page.findByText(created.shortCode);
    fireEvent.click(page.getByRole("button", { name: "刷新配对状态" }));
    await page.findByText("LIME-RIVER-42");
    fireEvent.click(page.getByLabelText("我已确认两边短语完全一致"));
    fireEvent.click(page.getByRole("button", { name: "批准此 Device" }));

    const retry = await page.findByRole("button", {
      name: "用同一 operationId 重试批准"
    });
    fireEvent.click(retry);
    await page.findByText("Device 已安全配对；一次性证明已从此标签页清除。");
    assert.equal(approveBodies.length, 2);
    assert.deepEqual(approveBodies[1], approveBodies[0]);
  } finally {
    cleanup();
    dom.window.close();
  }
});

test("Owner can cancel an issued session with its exact expected state", async () => {
  const dom = installDom();
  let cancelBody: Record<string, string> | null = null;
  globalThis.fetch = async (input, init = {}) => {
    const path = pathOf(input);
    if (path.endsWith("/device-pairing-sessions")) return jsonResponse(created);
    if (path.endsWith("/cancel")) {
      cancelBody = JSON.parse(String(init.body)) as Record<string, string>;
      return jsonResponse(projection("canceled"));
    }
    return jsonResponse(projection("issued"));
  };

  const { cleanup, fireEvent, render, within } = await import("@testing-library/react");
  try {
    render(
      <DevicePairingPanel
        currentMemberIsOwner
        currentMemberId={created.ownerMemberId}
        locale="zh-CN"
        sessionToken="session_owner"
        teamId={teamId}
      />
    );
    const page = within(dom.window.document.body);
    fireEvent.click(page.getByRole("button", { name: "创建设备配对" }));
    await page.findByText(created.shortCode);
    fireEvent.click(page.getByRole("button", { name: "取消本次配对" }));
    await page.findByText(/本次配对已取消/u);
    assert.deepEqual(cancelBody, {
      operationId: (cancelBody as Record<string, string> | null)?.operationId,
      expectedState: "issued"
    });
  } finally {
    cleanup();
    dom.window.close();
  }
});

test("Owner can reject a claimed Device without exposing local details", async () => {
  const dom = installDom();
  let current = projection("claimed");
  let rejectBody: Record<string, string> | null = null;
  globalThis.fetch = async (input, init = {}) => {
    const path = pathOf(input);
    if ((init.method ?? "GET") === "POST" && path.endsWith("/device-pairing-sessions")) {
      return jsonResponse(created);
    }
    if (path.endsWith("/reject")) {
      rejectBody = JSON.parse(String(init.body)) as Record<string, string>;
      current = projection("rejected");
      return jsonResponse(current);
    }
    return jsonResponse(current);
  };

  const { cleanup, fireEvent, render, within } = await import("@testing-library/react");
  try {
    render(
      <DevicePairingPanel
        currentMemberIsOwner
        currentMemberId={created.ownerMemberId}
        locale="zh-CN"
        sessionToken="session_owner"
        teamId={teamId}
      />
    );
    const page = within(dom.window.document.body);
    fireEvent.click(page.getByRole("button", { name: "创建设备配对" }));
    await page.findByText(created.shortCode);
    fireEvent.click(page.getByRole("button", { name: "刷新配对状态" }));
    await page.findByText("LIME-RIVER-42");
    fireEvent.change(page.getByLabelText("拒绝原因（可选）"), {
      target: { value: "Verification phrase did not match" }
    });
    fireEvent.click(page.getByRole("button", { name: "拒绝" }));
    await page.findByText(/本次配对已拒绝/u);
    assert.deepEqual(rejectBody, {
      operationId: (rejectBody as Record<string, string> | null)?.operationId,
      expectedState: "claimed",
      reason: "Verification phrase did not match"
    });
    assert.doesNotMatch(JSON.stringify(rejectBody), /workspace|command|credential|serverToken|runtime/u);
  } finally {
    cleanup();
    dom.window.close();
  }
});
