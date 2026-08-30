import assert from "node:assert/strict";
import test from "node:test";

import { JSDOM } from "jsdom";
import type { ChangeEvent, FormEvent } from "react";

import {
  keepMentionsPreferenceKey,
  readKeepMentionsPreference,
  writeKeepMentionsPreference
} from "../src/features/room/mention-retention.js";
import { useRoomComposer } from "../src/features/room/useRoomComposer.js";
import type { Agent, DiscussionView } from "../src/models.js";

const builder: Agent = {
  agentId: "agent_builder", name: "Local Codex", role: "Builder",
  integrationMode: "managed", presence: "ready", enabled: true
};
const reviewer: Agent = {
  ...builder, agentId: "agent_reviewer", name: "Reviewer", role: "Reviewer"
};

test("composer retains explicit recipients only with local opt-in", async (t) => {
  const dom = new JSDOM("<!doctype html><html><body></body></html>", {
    url: "http://localhost/"
  });
  const descriptors = Object.getOwnPropertyDescriptors(globalThis);
  Object.defineProperties(globalThis, {
    document: { configurable: true, value: dom.window.document },
    HTMLElement: { configurable: true, value: dom.window.HTMLElement },
    localStorage: { configurable: true, value: dom.window.localStorage },
    navigator: { configurable: true, value: dom.window.navigator },
    window: { configurable: true, value: dom.window },
    IS_REACT_ACT_ENVIRONMENT: { configurable: true, value: true, writable: true }
  });
  const { act, cleanup, renderHook } = await import("@testing-library/react");
  const requests: Array<{ path: string; body: Record<string, unknown> }> = [];
  const errors: Array<string | null> = [];
  const originalFetch = globalThis.fetch;
  const response = () => new Response(JSON.stringify({
    message: { messageId: `msg_${requests.length}` }, runs: []
  }), { headers: { "content-type": "application/json" } });
  let respond: () => Response | Promise<Response> = response;
  globalThis.fetch = async (input, init) => {
    if (!init?.body) {
      const value = String(input).endsWith("/settings")
        ? { room: { roomId: "room_one", teamId: "team_one" }, participants: { agentIds: [builder.agentId, reviewer.agentId] } }
        : [builder, reviewer];
      return new Response(JSON.stringify(value), { headers: { "content-type": "application/json" } });
    }
    requests.push({ path: String(input), body: JSON.parse(String(init?.body)) });
    return respond();
  };
  function mount() {
    const input: Parameters<typeof useRoomComposer>[0] = {
      activeDiscussion: null,
      agentRoleLabel: ({ role }) => role,
      agents: [builder, reviewer], roomAgents: [builder, reviewer],
      locale: "zh-CN", onDelivered: async () => {},
      onError: (error) => errors.push(error), onRoomStateChanged: async () => {},
      roomPolicy: {
        allowAll: true, allowDiscussion: false,
        allowAgentMentions: true, maxAgentMentionDepth: 4
      },
      selectedRoomId: "room_one", selectedTaskId: "task_one",
      session: { userId: "user_one", displayName: "Owner" }
    };
    const hook = renderHook(useRoomComposer, { initialProps: input });
    const type = (content: string) => act(() => hook.result.current.handleChange({
      currentTarget: { value: content, selectionStart: content.length }
    } as ChangeEvent<HTMLTextAreaElement>));
    const submit = () => act(async () => {
      await hook.result.current.submit({ preventDefault() {} } as FormEvent);
    });
    const enable = (value = true) => act(() => hook.result.current.changeKeepMentions(value));
    return { ...hook, enable, input, submit, type };
  }
  t.beforeEach(() => {
    cleanup();
    dom.window.localStorage.clear();
    requests.length = 0;
    errors.length = 0;
    respond = response;
  });

  try {
    await t.test("default-off and opt-in preference survive remount without recipients", async () => {
      const h = mount();
      assert.equal(h.result.current.keepMentions, false);
      h.type("@Local Codex 分析方案");
      await h.submit();
      assert.equal(requests[0]?.body.mentionAgentId, builder.agentId);
      assert.equal(h.result.current.messageContent, "");
      h.enable();
      h.type("@Local Codex 第二点呢");
      await h.submit();
      assert.equal(h.result.current.messageContent, "@Local Codex ");
      assert.deepEqual(h.result.current.selectedMentionAgents.map(({ agentId }) => agentId), [builder.agentId]);
      assert.equal(localStorage.getItem(keepMentionsPreferenceKey), "true");
      assert.equal(localStorage.length, 1);
      h.unmount();
      const restored = mount();
      assert.equal(restored.result.current.keepMentions, true);
      assert.equal(restored.result.current.messageContent, "");
      assert.deepEqual(restored.result.current.selectedMentionAgents, []);
      restored.enable(false);
      restored.unmount();
      assert.equal(mount().result.current.keepMentions, false);
    });

    await t.test("follow-ups retain A, reject token-only send, and remove visibly", async () => {
      const h = mount();
      h.enable();
      h.type("@Local Codex 开始");
      await h.submit();
      assert.equal(h.result.current.hasMessageText, false);
      await h.submit();
      assert.equal(requests.length, 1);
      h.type(`${h.result.current.messageContent}继续第二点`);
      await h.submit();
      assert.equal(requests[1]?.body.mentionAgentId, builder.agentId);
      assert.notEqual(requests[0]?.body.clientMessageId, requests[1]?.body.clientMessageId);
      assert.equal(h.result.current.messageContent, "@Local Codex ");
      act(() => h.result.current.removeMention(builder));
      assert.equal(h.result.current.messageContent, "");
      h.type("只是房间留言");
      await h.submit();
      assert.equal(requests[2]?.body.mentionAgentId, undefined);
      assert.equal(h.result.current.messageContent, "");
    });

    await t.test("turning off removes only automatic tokens and preserves the new draft", async () => {
      const h = mount();
      h.enable();
      h.type("@Local Codex 开始");
      await h.submit();
      h.type(`${h.result.current.messageContent}我的新内容 @Reviewer`);
      h.enable(false);
      assert.equal(h.result.current.messageContent, "我的新内容 @Reviewer");
      await h.submit();
      assert.equal(requests[1]?.body.mentionAgentId, reviewer.agentId);
      assert.equal(h.result.current.messageContent, "");
    });

    await t.test("deleting or replacing a retained token cannot resurrect its target", async () => {
      const h = mount();
      h.enable();
      h.type("@Local Codex 开始");
      await h.submit();
      h.type("@Reviewer 换你回答");
      await h.submit();
      assert.equal(requests[1]?.body.mentionAgentId, reviewer.agentId);
      assert.equal(h.result.current.messageContent, "@Reviewer ");
      h.type("没有接收者");
      await h.submit();
      assert.equal(requests[2]?.body.mentionAgentId, undefined);
      assert.equal(h.result.current.messageContent, "");
    });

    await t.test("Room, Task, and user changes clear targets without changing the preference", async () => {
      for (const change of [
        { selectedRoomId: "room_two" }, { selectedTaskId: "task_two" },
        { session: { userId: "user_two", displayName: "Other" } }
      ]) {
        const h = mount();
        h.enable();
        h.type("@Local Codex 开始");
        await h.submit();
        h.rerender({ ...h.input, ...change });
        assert.equal(h.result.current.messageContent, "");
        assert.deepEqual(h.result.current.selectedMentionAgents, []);
        assert.equal(h.result.current.keepMentions, true);
        h.unmount();
      }
    });

    await t.test("removed, disabled, and renamed targets cannot retarget a same-name Agent", async () => {
      for (const kind of ["removed", "disabled", "renamed", "unassigned"]) {
        const h = mount();
        h.enable();
        h.type("@Local Codex 开始");
        await h.submit();
        const changed = kind === "disabled" ? { ...builder, enabled: false }
          : { ...builder, name: "New Name" };
        const replacement = { ...reviewer, name: builder.name };
        const nextAgents = kind === "removed" ? [replacement] : [changed, replacement];
        h.rerender({
          ...h.input, agents: nextAgents,
          roomAgents: kind === "unassigned" ? [replacement] : nextAgents
        });
        assert.equal(h.result.current.messageContent, "", kind);
        assert.deepEqual(h.result.current.selectedMentionAgents, [], kind);
        h.type("普通留言");
        await h.submit();
        assert.equal(requests.at(-1)?.body.mentionAgentId, undefined, kind);
        h.unmount();
      }
    });

    await t.test("offline targets remain and explicit roster reconciliation prunes tokens", async () => {
      const h = mount();
      h.enable();
      h.type("@Local Codex 开始");
      await h.submit();
      h.rerender({ ...h.input, roomAgents: [{ ...builder, presence: "offline" }, reviewer] });
      assert.equal(h.result.current.messageContent, "@Local Codex ");
      h.type(`${h.result.current.messageContent}稍后处理`);
      await h.submit();
      assert.equal(requests[1]?.body.mentionAgentId, builder.agentId);
      act(() => h.result.current.retainMentionAgentIds([reviewer.agentId]));
      assert.equal(h.result.current.messageContent, "");
    });

    await t.test("@all freezes concrete IDs while new roster members are not added", async () => {
      const h = mount();
      h.enable();
      h.type("@all 一起分析");
      await h.submit();
      assert.deepEqual(requests[0]?.body.mentionAgentIds, [builder.agentId, reviewer.agentId]);
      assert.equal(h.result.current.messageContent, "@Local Codex @Reviewer ");
      const newAgent = { ...builder, agentId: "agent_new", name: "Newcomer" };
      h.rerender({
        ...h.input, agents: [...h.input.agents, newAgent],
        roomAgents: [...h.input.roomAgents, newAgent],
        roomPolicy: { ...h.input.roomPolicy, allowAll: false }
      });
      h.type(`${h.result.current.messageContent}继续`);
      await h.submit();
      assert.deepEqual(requests[1]?.body.mentionAgentIds, [builder.agentId, reviewer.agentId]);
      assert.equal(h.result.current.exactMentionCommands.usesAll, false);
    });

    await t.test("same-name suggestion retains the selected identity, not every match", async () => {
      const h = mount();
      const sameName = { ...reviewer, name: builder.name };
      h.rerender({ ...h.input, agents: [builder, sameName], roomAgents: [builder, sameName] });
      h.enable();
      h.type("@Loc");
      act(() => h.result.current.selectMention(sameName));
      h.type(`${h.result.current.messageContent}审查`);
      await h.submit();
      assert.equal(requests[0]?.body.mentionAgentId, sameName.agentId);
      h.type(`${h.result.current.messageContent}继续`);
      await h.submit();
      assert.equal(requests[1]?.body.mentionAgentId, sameName.agentId);
      assert.equal(h.result.current.selectedMentionAgents[0]?.role, "Reviewer");
    });

    await t.test("retry reuses its original multi-target payload without altering a newer draft", async () => {
      const h = mount();
      h.enable();
      respond = () => new Response("unavailable", { status: 503 });
      h.type("@all 一起分析");
      await h.submit();
      const pending = h.result.current.pendingMessages[0]!;
      assert.equal(pending.status, "failed");
      h.type("@Reviewer 另一条消息");
      respond = response;
      await act(async () => h.result.current.deliver(pending));
      assert.deepEqual(requests[1]?.body, requests[0]?.body);
      assert.equal(h.result.current.messageContent, "@Reviewer 另一条消息");
      assert.equal(h.result.current.pendingMessages.length, 0);
      await h.submit();
      assert.equal(requests[2]?.body.mentionAgentId, reviewer.agentId);
    });

    await t.test("Discussion preserves policy, failure drafts, and successful recipients", async () => {
      const h = mount();
      const policy = { ...h.input.roomPolicy, allowDiscussion: true };
      h.rerender({ ...h.input, roomPolicy: policy });
      h.enable();
      h.type("@all 讨论方案");
      respond = () => new Response("unavailable", { status: 503 });
      await h.submit();
      assert.equal(h.result.current.messageContent, "@all 讨论方案");
      assert.equal(h.result.current.pendingMessages.length, 0);
      respond = response;
      await h.submit();
      assert.equal(requests[1]?.path, "/api/rooms/room_one/discussions");
      assert.deepEqual(requests[1]?.body.participantAgentIds, [builder.agentId, reviewer.agentId]);
      assert.equal(h.result.current.messageContent, "@Local Codex @Reviewer ");
      h.rerender({ ...h.input, roomPolicy: policy, activeDiscussion: {} as DiscussionView });
      h.type(`${h.result.current.messageContent}再讨论`);
      await h.submit();
      assert.equal(requests.length, 2);
      assert.match(errors.at(-1) ?? "", /已有协作讨论/u);
    });

    await t.test("late Discussion responses cannot restore a cleared scope or overwrite edits", async () => {
      for (const change of ["room", "task", "roundtrip", "edit", "off"]) {
        const h = mount();
        const input = { ...h.input, roomPolicy: { ...h.input.roomPolicy, allowDiscussion: true } };
        h.rerender(input);
        h.enable();
        h.type("@all 讨论方案");
        let resolve!: (response: Response) => void;
        respond = () => new Promise<Response>((done) => { resolve = done; });
        let sending!: Promise<void>;
        act(() => {
          sending = h.result.current.submit({ preventDefault() {} } as FormEvent);
        });
        if (change === "room" || change === "roundtrip") {
          h.rerender({ ...input, selectedRoomId: "room_two" });
          if (change === "roundtrip") h.rerender(input);
        } else if (change === "task") {
          h.rerender({ ...input, selectedTaskId: "task_two" });
        } else if (change === "edit") {
          h.type("我的新草稿");
        } else {
          h.enable(false);
        }
        await act(async () => { resolve(response()); await sending; });
        assert.equal(h.result.current.messageContent, change === "edit" ? "我的新草稿" : "", change);
        assert.deepEqual(h.result.current.selectedMentionAgents, [], change);
        h.unmount();
      }
    });

    await t.test("reserved names cannot turn a retained concrete recipient into @all", async () => {
      const h = mount();
      const reserved = { ...builder, name: "all" };
      h.rerender({ ...h.input, agents: [reserved], roomAgents: [reserved] });
      h.enable();
      h.type("@all 开始");
      await h.submit();
      assert.equal(h.result.current.messageContent, "");
    });

    await t.test("blocked or malformed local storage fails safely", () => {
      localStorage.setItem(keepMentionsPreferenceKey, "not-a-boolean");
      assert.equal(readKeepMentionsPreference(), false);
      Object.defineProperty(globalThis, "localStorage", {
        configurable: true, get() { throw new Error("storage blocked"); }
      });
      assert.equal(readKeepMentionsPreference(), false);
      assert.doesNotThrow(() => writeKeepMentionsPreference(true));
      const h = mount();
      h.enable();
      assert.equal(h.result.current.keepMentions, true);
    });
  } finally {
    cleanup();
    globalThis.fetch = originalFetch;
    for (const key of ["document", "HTMLElement", "localStorage", "navigator", "window", "IS_REACT_ACT_ENVIRONMENT"]) {
      if (descriptors[key]) Object.defineProperty(globalThis, key, descriptors[key]!);
      else Reflect.deleteProperty(globalThis, key);
    }
    dom.window.close();
  }
});
