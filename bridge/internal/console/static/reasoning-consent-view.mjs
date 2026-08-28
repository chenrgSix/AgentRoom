export function reasoningConsentView(state, interactionBusy = false) {
  const activeRuns = (state.agents || []).reduce((total, agent) => total + (agent.activeRuns || 0), 0);
  if (!state.paired) {
    return {
      action: "edit",
      disabled: true,
      guidance: "完成 Device 配对后，才能为当前中央服务更改摘要共享授权。"
    };
  }
  if (activeRuns > 0) {
    return {
      action: state.bridgeRunning ? "stop" : "edit",
      disabled: true,
      guidance: `还有 ${activeRuns} 个任务正在执行；等待任务结束后再停止 Bridge。`
    };
  }
  if (interactionBusy) {
    return {
      action: state.bridgeRunning ? "stop" : "edit",
      disabled: true,
      guidance: "请等待当前配对、Runtime 自检或预检结束。"
    };
  }
  if (state.bridgeRunning) {
    return {
      action: "stop",
      disabled: false,
      guidance: "更改授权前必须停止 Bridge；点击右侧按钮只停止连接，不会修改当前授权。"
    };
  }
  if (!state.reasoningConsentEditable) {
    return {
      action: "edit",
      disabled: true,
      guidance: "Bridge 正在停止并等待后台连接退出，完成后即可更改授权。"
    };
  }
  return {
    action: "edit",
    disabled: false,
    guidance: "更改只影响后续摘要；已经上传的内容无法撤回。"
  };
}
