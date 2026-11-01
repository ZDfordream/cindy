/**
 * OnboardingSessionHost — S3 引导弹窗宿主 + 「更多 → 自定义」的首页侧收口（Task 7）。
 *
 * 挂在 `NewMakerDraftRoute` 的 `ModelGatewayProvider` **之内**（`HomeOnboardingGateProvider`
 * 的内容位）：S3 保存成功必须即时翻转首页两态（横幅折叠 / 圆点变绿），所以宿主与首页
 * 必须共用同一份 `ModelGatewayScope` 条目表——挂在 provider 外就是 Task 6 登记的
 * 双 store 灾难（保存只翻一半）。
 *
 * **S3 出现规则（FR-SESSION-05，全计划最细的一条）**：
 * - 只有「显式登录」（S2 手输，`hrOaAuthStore.login()` 成功）才立引导资格；「仅启动且
 *   登录态有效」（`hrOa:state` 静默落定）不立资格 → 不弹 S3，只留未配置横幅（S4b）。
 * - 资格在**做出决定**时才消费（`consumeHrOaOnboardingEligibility`）：条目表 hydrate
 *   前的 `[]` 只是「还没读到」（同 homeGatePhaseOf 的 hydrated 合同），不许拿它判
 *   「无模型」。决定 = 弹 S3（空表，必经）或直接 S4a（已有模型，T3b）——两者都消费，
 *   一次显式登录只弹一次；跳过后再登（仍无模型）会再次立资格、再次必经（FR-SESSION-05）。
 *
 * **T3/T4 编排（PRD §9.2）**：资格待决期间首页内容以「预览姿态」（`body[data-hr-s3-preview]`
 * → `[data-hr-home-root]` 半透明 + 下沉）呈现在弹窗遮罩（blur + 变暗，modal-scrim 既有）
 * 之下；决定弹 S3 后延迟 `HR_OA_S3_DIALOG_DELAY_MS` 出弹窗；跳过 / 保存后姿态归位
 * （settle）。时长 / 曲线走登记 token（reduce 下全局 `transition: none` 瞬时切换），
 * 编排状态本身在 body 数据属性上，可观察、可测试。
 *
 * **弹窗双回调合同（Task 5 deferred minor）**：保存成功尾 `OnboardingModelDialog` 会**既**
 * 回 `onSaved(id)` **又**回 `onClose()`。两个回调都只表示「弹窗结束」——`onSaved` 先落
 * `lastSaveRef` 记账，结束出口读完再清；绝不把 `onClose` 当「用户放弃配置」。两态视觉
 * 不靠回调分支：共用 store 里 `entries` 翻转即驱动（T5），回调只管窗与预览姿态。
 *
 * **「更多 → 自定义」（FR-HOME-02 / AC-14）**：菜单不在首页子树里，经
 * `requestHomeCustomizeDialog()` 模块通道把意图递给本宿主，由宿主转
 * `HomeGateSurface.openDialog('customize')`——与 T6 同一弹窗（origin=home，无跳过、
 * 无底部提示）、同一防重入 / 焦点归还 / 双回调纪律（Task 6 宿主合同零复制）。首页
 * 未挂载（会话页等）时通道无人认领，菜单条目回落自带弹窗，行为仍是「关回原界面」。
 */
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from 'react';

import { useReducedMotion } from '@/hooks/useReducedMotion';
import {
  flushHrOaHomeArrival,
  noteHrOaHomeArrival,
} from '@/lib/hrOaTelemetry';

import { OnboardingModelDialog } from '../model-gateway/OnboardingModelDialog';
import { useHomeGateSurface } from '../model-gateway/homeOnboardingGate';
import { useModelGateway } from '../model-gateway/ModelGatewayStore';
import {
  consumeHrOaOnboardingEligibility,
  hrOaOnboardingEligibilityPending,
} from './hrOaAuthStore';

/**
 * T3 弹窗延迟（PRD §9.2：首页预览姿态落定后 240ms 弹窗才出现）。行为节拍（同
 * `HR_OA_SUCCESS_BEAT_MS` 的口径，不是 CSS 时长）；reduce 下归零（§9.5 瞬时切换）。
 */
export const HR_OA_S3_DIALOG_DELAY_MS = 240;

/** 「更多 → 自定义」的首页侧消费者（返回 true = 已被首页弹窗认领）。 */
type HomeCustomizeConsumer = () => boolean;

let homeCustomizeConsumer: HomeCustomizeConsumer | null = null;

/** 首页宿主挂载期间认领「自定义」请求（卸载即释放；注册方见 OnboardingSessionHost）。 */
export function registerHomeCustomizeConsumer(consumer: HomeCustomizeConsumer): () => void {
  homeCustomizeConsumer = consumer;
  return () => {
    if (homeCustomizeConsumer === consumer) homeCustomizeConsumer = null;
  };
}

/**
 * 「更多 → 自定义」请求入口（菜单条目调用）。有首页宿主在 = 走 Task 6 的补配弹窗
 * 宿主（与首页共享 store）；没有（会话页等）= 回 false，调用方开自带弹窗。
 */
export function requestHomeCustomizeDialog(): boolean {
  return homeCustomizeConsumer ? homeCustomizeConsumer() : false;
}

type S3Phase =
  | 'idle' // 无显式登录资格（启动恢复 / 已消费完）：不弹不预览。
  | 'pending' // 资格待决（等 hydrate 决定）：首页已在预览姿态。
  | 'showing' // S3 弹窗打开中：预览姿态保持（遮罩下）。
  | 'settled'; // 弹过 / 已有模型 / 跳过保存完：姿态归位，不再弹。

export function OnboardingSessionHost(props: { children?: ReactNode }) {
  const { entries, hydrated } = useModelGateway();
  const surface = useHomeGateSurface();
  const reducedMotion = useReducedMotion();
  const [phase, setPhase] = useState<S3Phase>('idle');
  // Task 5 双回调合同：onSaved 先记账，结束出口读出再清（同 homeOnboardingGate 纪律）。
  const lastSaveRef = useRef<string | null>(null);
  // 资格判定只跑一次：cleanup / 竞态下不许把消费掉的资格再决定一遍。
  const decidedRef = useRef(false);

  // 显式登录资格（模块级记忆，跨 ownerKey 重挂载存活）→ 进入待决 + 预览姿态。
  useEffect(() => {
    if (phase !== 'idle' || decidedRef.current) return;
    if (hrOaOnboardingEligibilityPending()) setPhase('pending');
  }, [phase]);

  // 预览姿态（T3/T4）：待决与弹窗期间首页内容半透明下沉；归位即 settle。
  useEffect(() => {
    const posed = phase === 'pending' || phase === 'showing';
    if (posed) document.body.dataset.hrS3Preview = 'on';
    else delete document.body.dataset.hrS3Preview;
    return () => {
      delete document.body.dataset.hrS3Preview;
    };
  }, [phase]);

  // 决定点：hydrate 落定后判「有没有模型」（FR-SESSION-05 / T3b）。
  useEffect(() => {
    if (phase !== 'pending' || !hydrated || decidedRef.current) return;
    decidedRef.current = true;
    const eligible = consumeHrOaOnboardingEligibility();
    if (!eligible || entries.length > 0) {
      setPhase('settled');
      return;
    }
    const delay = reducedMotion ? 0 : HR_OA_S3_DIALOG_DELAY_MS;
    // §9.5 状态瞬时切换：reduce / 0 延迟直落，不挂 timer（fake timers 下也不留尾巴）。
    if (delay <= 0) {
      setPhase('showing');
      return;
    }
    const timer = window.setTimeout(() => setPhase('showing'), delay);
    return () => window.clearTimeout(timer);
  }, [phase, hydrated, entries, reducedMotion]);

  // 「更多 → 自定义」→ 同一补配弹窗（Task 6 宿主；origin=home）。
  useEffect(() => {
    return registerHomeCustomizeConsumer(() => {
      if (!surface) return false;
      surface.openDialog('customize');
      return true;
    });
  }, [surface]);

  // home_view 落定消费点（PRD §10.2）：到达账本（login/launch/skip/save）在首页**曝光
  // 落定**时消费一次——落定 = 条目表水合完成 + S3 不再悬挂（无资格 / 决定不弹 / 弹完
  // 收场）。S3 进行中（pending 待决 / showing 弹窗压着首页）不发：「到达」与「曝光」
  // 之间隔着弹窗落定（冷启动 arm→首页水合 flush；S3 结束当场落定 flush）。entries
  // 翻转会重跑本 effect：S4b 补配保存（entry=save）也算一次到达（两态翻转即新曝光）。
  // 资格待决再挡一道：显式登录后 mount 首帧 phase 还是 idle，防抢在 S3 决策前误发。
  useEffect(() => {
    if (!hydrated) return;
    if (phase === 'pending' || phase === 'showing') return;
    if (hrOaOnboardingEligibilityPending()) return;
    flushHrOaHomeArrival(entries.length > 0 ? 'configured' : 'unconfigured');
  }, [phase, hydrated, entries]);

  const handleSaved = useCallback((id: string) => {
    // 成功尾先回 onSaved 再回 onClose：这里只记账 + 收场，视觉由 entries 翻转驱动。
    lastSaveRef.current = id;
    // S3 保存 = 「经保存到达首页」：改写到达原因（PRD home_view.entry=save）。
    noteHrOaHomeArrival('save');
    setPhase('settled');
  }, []);

  const handleDialogEnd = useCallback(() => {
    // 跳过 / 关闭 / 保存成功的收尾都走这里：读出「本次结束是否带保存」再清账。
    // onClose ≠ 用户放弃（放弃也保留输入、不回退两态）；S3 的两态本就由 entries 驱动。
    // 埋点：双回调合同下保存成功尾先落 lastSaveRef（handleSaved）——非保存收尾
    // （× / 取消 / 跳过 / Esc / 无输入遮罩）= 跳过（PRD home_view.entry=skip）。
    const saved = lastSaveRef.current !== null;
    lastSaveRef.current = null;
    if (!saved) noteHrOaHomeArrival('skip');
    setPhase('settled');
  }, []);

  return (
    <>
      <div
        data-testid="onboarding-session-surface"
        style={{ display: 'contents' }}
        inert={phase === 'showing' || undefined}
        aria-hidden={phase === 'showing' || undefined}
      >
        {props.children}
      </div>
      <OnboardingModelDialog
        open={phase === 'showing'}
        origin="onboarding"
        trackOrigin="onboarding"
        onSkipped={handleDialogEnd}
        onSaved={handleSaved}
        onClose={handleDialogEnd}
      />
    </>
  );
}
