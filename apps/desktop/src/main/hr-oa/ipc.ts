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
import type { HrOaAuthState, HrOaSessionManager } from './sessionManager.js';

export function registerHrOaIpc(deps: { manager: HrOaSessionManager }): void {
  const { manager } = deps;

  const project = (state: HrOaAuthState): void => {
    setHrOaProfileProjection(state.status === 'signed-out' ? null : state.profile);
  };
  manager.onDidChange(project);
  // startup() 落定早于注册时，把既有状态先对齐到投影，避免漏一次推送。
  project(manager.getState());

  ipcMain.handle('hrOa:login', async (event, username: unknown, password: unknown) => {
    assertTrustedAppRendererEvent(event);
    return manager.login(
      requireString(username, 'username'),
      requireString(password, 'password'),
    );
  });

  ipcMain.handle('hrOa:logout', async (event) => {
    assertTrustedAppRendererEvent(event);
    await manager.logout();
  });

  ipcMain.handle('hrOa:state', (event) => {
    assertTrustedAppRendererEvent(event);
    return manager.getState();
  });
}
