/**
 * hrOaAuthStore.ts — renderer 侧 HR OA 登录态镜像。
 *
 * 经 preload 桥（`window.electronAPI.hrOa.*`）消费 Task 2 的 `hrOa:login` / `hrOa:logout` /
 * `hrOa:state` IPC；状态变化不另开推送通道，**骑现有 `auth:state-change`**（payload 带
 * `hrProfile`）后重拉一次 `hrOa:state`，以拿到含 accountKey 的完整 `HrOaAuthState`。
 *
 * 口令只经 `login(username, password)` 入参过桥进 main；不进本模块的 state、不落盘。
 */

import { useCallback, useEffect, useState } from 'react';

import type { OaLoginFailure } from '../../../main/hr-oa/errors';
import type { PersonProfile } from '../../../main/hr-oa/profile';
import type { HrOaAuthState } from '../../../main/hr-oa/sessionManager';

export type { HrOaAuthState, OaLoginFailure, PersonProfile };

/** `hrOa:login` 的原样回包：显式登录失败恒为 `{ error }`（Ruling 3），成功为新状态。 */
export type HrOaLoginResult = HrOaAuthState | { error: OaLoginFailure };

export interface HrOaAuthApi {
  /** 当前登录态；桥不可用或尚未拉回时为 `null`。 */
  state: HrOaAuthState | null;
  login: (username: string, password: string) => Promise<HrOaLoginResult>;
  logout: () => Promise<void>;
}

export function useHrOaAuth(): HrOaAuthApi {
  const [state, setState] = useState<HrOaAuthState | null>(null);

  useEffect(() => {
    let cancelled = false;
    const sync = (): void => {
      void window.electronAPI.hrOa
        .getState()
        .then((next) => {
          if (!cancelled) setState(next);
        })
        .catch(() => {
          // 桥尚未接线（Task 4 前）或拉取失败：保持 null，不伪造 signed-out。
        });
    };
    sync();
    const unsubscribe = window.electronAPI.onAuthStateChange(() => {
      sync();
    });
    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, []);

  const login = useCallback(async (username: string, password: string) => {
    const result = await window.electronAPI.hrOa.login(username, password);
    if (!('error' in result)) setState(result);
    return result;
  }, []);

  const logout = useCallback(async () => {
    await window.electronAPI.hrOa.logout();
    setState({ status: 'signed-out' });
  }, []);

  return { state, login, logout };
}
