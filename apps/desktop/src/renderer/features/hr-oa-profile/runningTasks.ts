/**
 * runningTasks — 「进行中任务」的计数与真停（Ruling B，FR-LOGOUT-02/03）。
 *
 * **口径（owner 裁定 Ruling B）**：N = 当前账号（`dataOwnerId`）下**有在途 Agent 轮的
 * 会话数**。来源 = `makerChatStore.getRunningSnapshot()` 的 `isRunning` 条目——该快照
 * 已把伙伴后台轮（wake 型后台任务 / 唤醒桥接）与恢复中会话折算进 `isRunning`
 * （见 makerChatStore `computeRunningSnapshot` / `hasBackgroundAgentWork`），定时任务
 * （自动化）发起的执行轮同样以会话在途轮的形态计入。`dataOwnerId` 为空（signed-out /
 * 无账号）时恒 0——没有「当前账号」就没有该账号的在途轮。
 *
 * **账号边界**：会话快照不逐条携带 owner 键，隔离靠 owner 边界的整面收口
 * （`finalizeSessionsForDataOwnerBoundary` 等）；换号后旧会话不再有在途轮可计。
 * device-link 远程会话的 runtime 在被控端、终态事件有丢失窗口，是既有快照口径的
 * 已知边界（同 `confirmRunningTaskInterruption` 账号切换确认），此处不另立第二套。
 *
 * **先停后落（Review Focus #1 / FR-LOGOUT-03）**：确认退出后必须**先真停**这些工作
 * 再落 `signed-out`——只靠 UI 卸载会留下「登出后旧进程仍往旧 owner 分区写、用旧
 * 凭证发请求」的账号隔离漏洞。真停走用户 Stop 的同一生产路径
 * （`makerChatStore.stopSession`：renderer 立即收口 + `input.stop` 中断在途轮 /
 * 伙伴轮），由 `requestHrOaLogout` 在落登录态前调用。
 */

import { getDataOwnerGeneration } from '@/contexts/dataOwnerGeneration';
import { makerChatStore } from '@/lib/makerChatStore';

/** 当前账号下有在途 Agent 轮的会话数（含伙伴后台轮；无当前账号恒 0）。 */
export function countRunningAgentRuns(): number {
  const { dataOwnerId } = getDataOwnerGeneration();
  if (dataOwnerId === null) return 0;
  let count = 0;
  for (const info of makerChatStore.getRunningSnapshot().values()) {
    if (info.isRunning) count += 1;
  }
  return count;
}

/**
 * 真停当前账号下所有在途 Agent 轮（Stop 同路径）。幂等：停完再调零动作。
 * 调用方合同：必须在落 `signed-out` **之前**（顺序不可反，见文件头）。
 */
export function stopRunningAgentRuns(): void {
  const { dataOwnerId } = getDataOwnerGeneration();
  if (dataOwnerId === null) return;
  // 快照引用稳定（纯 getter 契约）；遍历副本防 stop 侧通知换代。
  const running = [...makerChatStore.getRunningSnapshot().entries()];
  for (const [sessionId, info] of running) {
    if (!info.isRunning) continue;
    makerChatStore.stopSession(sessionId);
  }
}
