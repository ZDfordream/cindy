/**
 * runningTasks — 「进行中任务」的计数与真停（Ruling B / Ruling F，FR-LOGOUT-02/03/05）。
 *
 * **口径（owner 裁定 Ruling B）**：N = 当前账号（`dataOwnerId`）下**有在途 Agent 轮的
 * 会话数**。来源 = `makerChatStore.getRunningSnapshot()` 的 `isRunning` 条目——该快照
 * 已把伙伴后台轮（wake 型后台任务 / 唤醒桥接）与恢复中会话折算进 `isRunning`
 * （见 makerChatStore `computeRunningSnapshot` / `hasBackgroundAgentWork`），定时任务
 * （自动化）发起的执行轮同样以会话在途轮的形态计入。`dataOwnerId` 为空（signed-out /
 * 无账号）时恒 0——没有「当前账号」就没有该账号的在途轮。
 *
 * **store 自登记（同步可停的装入合同）**：makerChatStore 装入时调
 * `registerRunningTaskStore` 自登记（makerChatStore → 本模块的单向运行时依赖；本模块
 * 对 makerChatStore 只有 `typeof import()` 类型引用，零运行时边）。因此
 * `stopRunningAgentRuns()` 可在 `landHrOaState` 落 signed-out 时**同步**执行（同步
 * 可停，不因动态 import 把落定拖后），不会像动态 import 那样把 S1 落定拖在重模块
 * 装入/失败之后（污染环境下 makerChatStore 链的失败延迟是秒级）。未登记（本窗从未
 * 装入会话 store）= 本窗无投影中的在途轮，零动作——真正持有这些轮的窗口装着 store，
 * 会在同一推送的落定里停掉（多窗口同响，stop 幂等）。
 *
 * **停轮顺序合同（Controller Ruling K，修正 Ruling B/F「先停后落」的普适说法）**：
 * **主动登出先停后落**（确认路径 requestHrOaLogout 在 logout IPC 前真停这些工作）；
 * **强制登出先清凭证与 cookie 并落 `signed-out`，renderer 随后即发 `stop`**
 * （landHrOaState 的落地停轮）。只靠 UI 卸载 / owner 边界的 renderer 收口
 * （forceFinalize，不发 input.stop）会留下「登出后旧进程仍往旧 owner 分区写、用旧
 * 凭证发请求」的账号隔离漏洞——隔离结果由「凭证/cookie 已清 + owner 纪元守卫 +
 * 落地时停轮」共同保证，不靠强退路径的停先于落。真停走用户 Stop 的同一生产路径
 * （`makerChatStore.stopSession`：renderer 立即收口 + `input.stop` 中断在途轮 /
 * 伙伴轮）。
 */

import { getDataOwnerGeneration } from '@/contexts/dataOwnerGeneration';

/**
 * 本模块用到的 store 面（`typeof import` 仅类型引用，零运行时边）。取子集让测试能
 * 以最小 fake 登记；makerChatStore 自登记时传完整实例（结构可赋）。
 */
type RunningTaskStore = Pick<
  typeof import('@/lib/makerChatStore').makerChatStore,
  'getRunningSnapshot' | 'stopSession'
>;

let store: RunningTaskStore | null = null;

/** makerChatStore 装入时自登记（幂等，后装入者覆盖）。 */
export function registerRunningTaskStore(ref: RunningTaskStore): void {
  store = ref;
}

/** 当前账号下有在途 Agent 轮的会话数（含伙伴后台轮；无当前账号恒 0）。 */
export function countRunningAgentRuns(): number {
  const { dataOwnerId } = getDataOwnerGeneration();
  if (dataOwnerId === null || !store) return 0;
  let count = 0;
  for (const info of store.getRunningSnapshot().values()) {
    if (info.isRunning) count += 1;
  }
  return count;
}

/**
 * 真停当前账号下所有在途 Agent 轮（Stop 同路径）。幂等：停完再调零动作；未登记
 * 零动作。调用方合同（Ruling K，见文件头）：主动登出必须在落 `signed-out` **之前**
 * 调本函数（先停后落）；强制登出在落定后由 renderer 随即补调（落地时停轮）。
 */
export function stopRunningAgentRuns(): void {
  const { dataOwnerId } = getDataOwnerGeneration();
  if (dataOwnerId === null || !store) return;
  // 快照引用稳定（纯 getter 契约）；遍历副本防 stop 侧通知换代。
  const running = [...store.getRunningSnapshot().entries()];
  for (const [sessionId, info] of running) {
    if (!info.isRunning) continue;
    store.stopSession(sessionId);
  }
}
