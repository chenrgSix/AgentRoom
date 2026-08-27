export function pairingView(state, now = Date.now()) {
  const enrollment = state.enrollment || {};
  const active = Boolean(enrollment.active);
  const devicePairing = Boolean(enrollment.pairingState);
  const deadline = Date.parse(devicePairing ? enrollment.pairingExpiresAt || "" : state.joinExpiresAt || "");
  const expired = active && (Boolean(enrollment.codeExpired) || (Number.isFinite(deadline) && deadline <= now));
  const seconds = Math.max(0, Math.ceil((deadline - now) / 1000));
  const canCopy = !devicePairing && active && !expired && Boolean(state.joinCode) && Number.isFinite(deadline);
  const connection = state.connection?.state || "stopped";
  let guidance = "完成下方本机配置后即可使用配对链接或短码，无需打开终端。";
  if (state.configured && !state.paired) {
    guidance = "尚未保存 Device 凭据。申请审批码后，请在目标 Team 的智能体管理页面审批。";
  } else if (state.paired && connection === "online") {
    guidance = "连接在线。Web 看不到智能体或旧数据时，请先核对网页用户与下方 Team ID；同名 Team 也可能不同。重新配对不会恢复旧 Team 的访问权限。";
  } else if (state.paired && (connection === "retrying" || connection === "connecting")) {
    guidance = "Bridge 正在连接。先检查连接详情、服务地址、中央 Token 与 HTTPS 信任；网络或协议错误不等于配对失效。需要新审批码时，请先停止 Bridge。";
  } else if (state.paired) {
    guidance = "已保存配对，但当前没有在线连接。可先启动现有配对；旧审批码是一次性的，不能再次使用。";
  }
  if (active) {
    guidance = devicePairing
      ? "请核对本机与中央 Web 显示的确认短语完全一致，再由 Owner 批准。配对期间本机配置与 Runtime 操作保持锁定。"
      : enrollment.recovery
      ? "正在申请新的 Device 身份。审批成功并保存前，旧配对与全部智能体配置保持不变；可取消返回。"
      : "请在中央 Web 选择目标 Team → 智能体管理 → Bridge 审批码，由 Owner 批准。";
  } else if (state.lastError && enrollment.recovery) {
    guidance = "重新配对未完成，旧配对仍保留。若中央已批准，请检查新建 Device；本地保存失败不会自动重复创建或撤销设备。";
  }
  return {
    status: active ? (devicePairing ? "等待确认短语" : "等待新审批") : state.paired ? "已保存配对" : "尚未配对",
    guidance,
    binding: state.paired ? `当前绑定 Team：${state.teamId} · Device：${state.deviceId}` : "尚未绑定 Team",
    showRequest: Boolean(state.configured),
    requestLabel: expired ? "重新申请审批码" : state.paired ? "申请新审批码（重新配对）" : "申请审批码",
    canRequest: Boolean(enrollment.canRequest || (active && expired)),
    blockedReason: active && expired ? "旧码已过期，重新申请会取消本次等待。" : enrollment.blockedReason || "",
    showApproval: active || expired,
    codeText: devicePairing && enrollment.verificationPhrase
      ? enrollment.verificationPhrase
      : canCopy ? state.joinCode : expired ? "审批码已过期" : "正在申请…",
    canCopy,
    approvalEyebrow: devicePairing ? "核对确认短语" : "等待 Owner 批准",
    approvalTitle: devicePairing ? "中央 Web 必须显示完全相同的短语" : "在中央 Web 管理界面输入此代码",
    expiry: canCopy
      ? `剩余 ${Math.floor(seconds / 60)} 分 ${seconds % 60} 秒 · 有效期至 ${new Date(deadline).toLocaleTimeString()}`
      : devicePairing && Number.isFinite(deadline)
        ? `配对有效期至 ${new Date(deadline).toLocaleTimeString()}`
        : expired ? "不要再使用旧码，请重新申请。" : "等待中央服务返回审批码。",
    canCancel: active,
    canStartExisting: Boolean(state.paired && !state.bridgeRunning && !active),
  };
}
