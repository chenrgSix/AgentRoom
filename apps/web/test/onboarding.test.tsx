import assert from "node:assert/strict";
import test from "node:test";

import { JSDOM } from "jsdom";
import React from "react";

import { App } from "../src/App.js";

interface RequestRecord {
  body?: string;
  method: string;
  path: string;
}

function jsonResponse(value: unknown): Response {
  return new Response(JSON.stringify(value), {
    headers: { "content-type": "application/json" },
    status: 200
  });
}

test("onboarding creates the first Team and reveals the Room step", async () => {
  const dom = new JSDOM("<!doctype html><html><body></body></html>", {
    url: "http://localhost/"
  });
  Object.defineProperties(globalThis, {
    document: { configurable: true, value: dom.window.document },
    HTMLElement: { configurable: true, value: dom.window.HTMLElement },
    localStorage: { configurable: true, value: dom.window.localStorage },
    navigator: { configurable: true, value: dom.window.navigator },
    window: { configurable: true, value: dom.window }
  });
  Object.defineProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT", {
    configurable: true,
    value: true,
    writable: true
  });

  const requests: RequestRecord[] = [];
  const team = {
    teamId: "team_test",
    name: "Platform Team",
    createdAt: "2026-08-23T00:00:00.000Z"
  };
  globalThis.fetch = async (input, init = {}) => {
    const path = typeof input === "string" ? input : input.url;
    const method = init.method ?? "GET";
    requests.push({
      ...(typeof init.body === "string" ? { body: init.body } : {}),
      method,
      path
    });
    if (path === "/api/bootstrap") {
      return jsonResponse({
        user: { userId: "user_test", displayName: "Local Owner" },
        session: { token: "session_test" }
      });
    }
    if (path === "/api/teams" && method === "POST") {
      return jsonResponse({ team });
    }
    if (path === "/api/teams") {
      const teamWasCreated = requests.some((request) =>
        request.path === "/api/teams" && request.method === "POST"
      );
      return jsonResponse(teamWasCreated ? [team] : []);
    }
    if (path.endsWith("/rooms") || path.endsWith("/agents") || path.endsWith("/devices")) {
      return jsonResponse([]);
    }
    throw new Error(`Unexpected request: ${method} ${path}`);
  };

  const { cleanup, fireEvent, render, screen, waitFor, within } = await import("@testing-library/react");
  try {
    render(<App />);
    const teamHeading = await screen.findByRole("heading", { name: "Create your first Team" });
    const teamStep = teamHeading.closest("section");
    assert.ok(teamStep);

    const nameInput = within(teamStep).getByLabelText("Team name") as HTMLInputElement;
    const createButton = within(teamStep).getByRole("button", { name: "Create Team" });
    assert.equal(nameInput.required, true);
    assert.equal((createButton as HTMLButtonElement).disabled, false);

    fireEvent.change(nameInput, { target: { value: "Platform Team" } });
    fireEvent.click(createButton);

    await screen.findByRole("heading", { name: "Create a conversation Room" });
    await waitFor(() => {
      const request = requests.find((candidate) =>
        candidate.path === "/api/teams" && candidate.method === "POST"
      );
      assert.deepEqual(JSON.parse(request?.body ?? "{}"), { name: "Platform Team" });
    });
    const roomInput = screen.getByLabelText("Room name") as HTMLInputElement;
    assert.equal(roomInput.required, true);
    assert.equal(
      (screen.getByRole("button", { name: "Create Room" }) as HTMLButtonElement).disabled,
      false
    );
  } finally {
    cleanup();
    dom.window.close();
  }
});
