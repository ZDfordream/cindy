/**
 * ipc.ts — HR OA 登录态 IPC（main 进程）。
 *
 * 通道：`hrOa:login`（(username, password) → HrOaAuthState | { error }）、`hrOa:logout`、
 * `hrOa:state`（拉取当前状态）。状态变化**骑现有 `auth:state-change` 推送**（同一推送
 * 形状、payload 增 `hrProfile`），不另开推送通道——renderer 只消费一处，避免两套登录态
 * 镜像打架。投影 setter 会广播，因此必须在 manager 落定并 commit 会话之后触发。
 *
 * 口令只经 `hrOa:login` 的 IPC 入参进 main（经 requireString 校验，错误文案不回显值），
 * 之后只进 OA client 与钥匙串密文槽；不进日志、不进状态对象。
 */

import { ipcMain } from 'electron';

import { setHrOaProfileProjection } from '../authManager.js';
import { assertTrustedAppRendererEvent } from '../security/trustedAppRenderer.js';
import { requireString } from '../utils/ipcValidate.js';
import { setHrOaTelemetryContext, trackHrOaEvent } from './telemetry.js';
import type { HrOaAuthState, HrOaSessionManager } from './sessionManager.js';

export function registerHrOaIpc(deps: {
  manager: HrOaSessionManager;
  /**
   * 冷启动静默重登（`manager.startup()`）的落定点。handler 在它 settle 前不回包：
   * 渲染层门禁据 `hrOa:state` 决策（S1 还是主界面），提前回未落定的状态会闪 S1。
   * 不传则维持即取即回（startup 早于注册的旧时序）。
   */
  whenSettled?: Promise<unknown>;
}): void {
  const { manager } = deps;
  const settled = deps.whenSettled ?? Promise.resolve();

  const project = (state: HrOaAuthState): void => {
    setHrOaProfileProjection(state.status === 'signed-out' ? null : state.profile);
    // 埋点 account_hash 的账号源 = 冻结账号键（accountKey，见 sessionManager）：
    // 同一人换登录形式（账号/工号/邮箱）键不变，账号级去重（首次配置率等）才拼得上。
    // signed-out 不清空：logout / welcome_view(from=logout) 仍属该账号的漏斗尾巴，
    // 下一次登录覆盖。
    if (state.status !== 'signed-out') {
      setHrOaTelemetryContext({ account: state.accountKey });
    }
  };
  manager.onDidChange(project);
  // startup() 落定早于注册时，把既有状态先对齐到投影，避免漏一次推送。
  project(manager.getState());

  // 埋点出口（PRD §10）：renderer 触发点经此进 main 的 trackHrOaEvent（组装 + 脱敏 + sink）。
  // fire-and-forget：埋点不得阻塞业务；载荷在 trackHrOaEvent 内按事件白名单裁剪，
  // 采集边界（口令/API Key/明文账号/完整 URL）在 sink 前收口（哨兵测试钉死）。
  ipcMain.on('hrOa:track-event', (event, name: unknown, props: unknown) => {
    assertTrustedAppRendererEvent(event);
    trackHrOaEvent(
      requireString(name, 'name'),
      typeof props === 'object' && props !== null ? (props as Record<string, unknown>) : {},
    );
  });

  ipcMain.handle('hrOa:login', async (event, username: unknown, password: unknown) => {
    assertTrustedAppRendererEvent(event);
    await settled;
    return manager.login(
      requireString(username, 'username'),
      requireString(password, 'password'),
    );
  });

  ipcMain.handle('hrOa:logout', async (event) => {
    assertTrustedAppRendererEvent(event);
    await settled;
    await manager.logout();
  });

  // 网络恢复（设计 §4.2「网络恢复后静默重登刷新会话」）：渲染层 `window 'online'` 是
  // 本仓既有恢复信号（main 侧无网络变化事件），多窗口同响由 manager 单飞合并。
  ipcMain.handle('hrOa:network-recovered', async (event) => {
    assertTrustedAppRendererEvent(event);
    await settled;
    return manager.networkRecovered();
  });

  ipcMain.handle('hrOa:state', async (event) => {
    assertTrustedAppRendererEvent(event);
    await settled;
    return manager.getState();
  });
}
