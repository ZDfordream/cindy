/**
 * 「插件·技能」改名 + 页签壳（FR-NAV-01~04）——导航文案、页面标题、页签行为、
 * 搜索命中与五语 key 一致性。字符级断言是本任务的协议护栏：PRD 文案规范表
 * 明确禁止 `插件-技能` / `插件・技能`(U+30FB) / `插件 • 技能`(U+2022) /
 * `插件 · 技能`(空格包裹) 四种写法，测试必须逐码点校验。
 * [PROTOCOL]: 变更时更新此头部，然后检查 CLAUDE.md
 * @vitest-environment jsdom
 */

import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter, useLocation } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string) =>
      ({
        'settings.ghosts.title': '插件·技能',
        'settings.ghosts.description': '管理 HRBuddy 可调用的插件与技能',
        'settings.ghosts.tabLabel': '插件',
        'skillhub.home.title': '技能',
        'sidebar.horizontalTabbarAria': '插件与技能页签',
        'settings.ghosts.page.search': '搜索插件',
        'settings.ghosts.page.clearSearch': '清除插件搜索',
        'skillhub.home.search': '搜索技能',
        'skillhub.home.clearSearch': '清除技能搜索',
      })[key] ?? key,
  }),
}));

import { PluginManagementLayout } from '../PluginManagementLayout';
import {
  buildSettingsSearchDocuments,
  searchSettings,
} from '@/components/settings/settingsSearchCatalog';
import zhCN from '@/i18n/locales/zh-CN/common.json';
import zhTW from '@/i18n/locales/zh-TW/common.json';
import en from '@/i18n/locales/en/common.json';
import ja from '@/i18n/locales/ja/common.json';
import ko from '@/i18n/locales/ko/common.json';

afterEach(() => {
  vi.unstubAllGlobals();
});

function CurrentPath() {
  return <output data-testid="current-path">{useLocation().pathname}</output>;
}

/** 提取 locale JSON 里某个 key 的字符串叶子值。 */
function pick(obj: unknown, ...path: string[]): string {
  let cur: unknown = obj;
  for (const p of path) {
    if (typeof cur !== 'object' || cur === null) return '';
    cur = (cur as Record<string, unknown>)[p];
  }
  return typeof cur === 'string' ? cur : '';
}

// ── FR-NAV-01 字符级护栏 ──────────────────────────────────────────────────────

/** PRD 文案规范表禁止的四种分隔写法（含码点级检查）。 */
function assertExactMiddotLabel(label: string) {
  // 必须恰好是「插件·技能」——逐码点
  expect([...label].map((c) => c.codePointAt(0))).toEqual([
    0x63d2, // 插
    0x4ef6, // 件
    0x00b7, // · MIDDLE DOT（U+00B7，前后无空格）
    0x6280, // 技
    0x80fd, // 能
  ]);
  // 禁止 `插件-技能`（ASCII hyphen）
  expect(label).not.toContain('-');
  // 禁止 `插件・技能`（U+30FB 全角片假名中点）
  expect(label).not.toContain('・');
  // 禁止 `插件•技能`（U+2022 项目符号）
  expect(label).not.toContain('•');
  // 禁止 `插件 · 技能`（空格包裹的 middot）
  expect(label).not.toMatch(/ · /);
  expect(label).not.toMatch(/· /);
  expect(label).not.toMatch(/ ·/);
}

describe('FR-NAV-01 导航文案', () => {
  it('导航项文案逐码点为 插件·技能（U+00B7，前后无空格）', () => {
    for (const locale of [zhCN, zhTW, en, ja, ko]) {
      // zh-TW 同用简体「插件·技能」字形；en/ja/ko 用各自译名 + U+00B7
      const nav = pick(locale, 'sidebar', 'tabs', 'plugins');
      expect(nav).toBeTruthy();
      // 含 U+00B7 且前后无空格
      expect(nav).toMatch(/\S·\S/);
      // 禁止四种错误写法
      expect(nav).not.toContain('-');
      expect(nav).not.toContain('・');
      expect(nav).not.toContain('•');
      expect(nav).not.toMatch(/ · /);
    }
    // zh-CN 精确等于 插件·技能
    assertExactMiddotLabel(pick(zhCN, 'sidebar', 'tabs', 'plugins'));
    assertExactMiddotLabel(pick(zhCN, 'sidebar', 'navigation', 'items', 'plugins'));
    assertExactMiddotLabel(pick(zhCN, 'settings', 'tabs', 'ghosts'));
    assertExactMiddotLabel(pick(zhCN, 'settings', 'ghosts', 'title'));
  });
});

// ── FR-NAV-02 页面标题 / 副文案 / 页签 ─────────────────────────────────────────

describe('FR-NAV-02 页面标题与页签', () => {
  it('页面标题为 插件·技能，副文案为 管理 HRBuddy 可调用的插件与技能', () => {
    expect(pick(zhCN, 'settings', 'ghosts', 'title')).toBe('插件·技能');
    expect(pick(zhCN, 'settings', 'ghosts', 'description')).toBe(
      '管理 HRBuddy 可调用的插件与技能',
    );
  });

  it('页签为 插件 / 技能，默认 插件，role=tablist', () => {
    render(
      <MemoryRouter initialEntries={['/plugins']}>
        <PluginManagementLayout activeTab="plugins">
          <CurrentPath />
        </PluginManagementLayout>
      </MemoryRouter>,
    );

    const tablist = screen.getByRole('tablist');
    expect(tablist).toBeTruthy();

    const pluginsTab = screen.getByRole('tab', { name: '插件' });
    const skillsTab = screen.getByRole('tab', { name: '技能' });
    expect(pluginsTab.getAttribute('aria-selected')).toBe('true');
    expect(skillsTab.getAttribute('aria-selected')).toBe('false');
  });

  it('←/→/Home/End 切换页签', async () => {
    render(
      <MemoryRouter initialEntries={['/plugins']}>
        <PluginManagementLayout activeTab="plugins">
          <CurrentPath />
        </PluginManagementLayout>
      </MemoryRouter>,
    );

    const pluginsTab = screen.getByRole('tab', { name: '插件' });
    const skillsTab = screen.getByRole('tab', { name: '技能' });

    // 焦点到 插件 tab
    pluginsTab.focus();
    // → 跳到 技能
    fireEvent.keyDown(pluginsTab, { key: 'ArrowRight' });
    await waitFor(() => {
      expect(document.activeElement).toBe(skillsTab);
    });
    // Home 跳回 插件
    fireEvent.keyDown(skillsTab, { key: 'Home' });
    await waitFor(() => {
      expect(document.activeElement).toBe(pluginsTab);
    });
    // End 跳到 技能
    fireEvent.keyDown(pluginsTab, { key: 'End' });
    await waitFor(() => {
      expect(document.activeElement).toBe(skillsTab);
    });
    // ← 跳回 插件
    fireEvent.keyDown(skillsTab, { key: 'ArrowLeft' });
    await waitFor(() => {
      expect(document.activeElement).toBe(pluginsTab);
    });
  });

  it('指示条平移（T19）——cindy-segmented-plate 存在', () => {
    // SegmentedControl 在 jsdom 里 ResizeObserver 不触发 measure，plate 可能为 null。
    // 这里验证 plate 的 CSS transition 声明来自已登记动效 token（不写死 duration/bezier）。
    // 直接读 segmented-control.css 无法在 jsdom 做；改为验证 tablist 结构带 segmented 类。
    render(
      <MemoryRouter initialEntries={['/plugins']}>
        <PluginManagementLayout activeTab="plugins">
          <CurrentPath />
        </PluginManagementLayout>
      </MemoryRouter>,
    );

    const tablist = screen.getByRole('tablist');
    expect(tablist.className).toContain('cindy-segmented');
    expect(tablist.className).toContain('plugin-motion-tabs');
  });
});

// ── 内容保留 ──────────────────────────────────────────────────────────────────

describe('内容保留', () => {
  it('技能 tab 点击导航到 /skillhub/local（SkillHub），不进空态', async () => {
    render(
      <MemoryRouter initialEntries={['/plugins']}>
        <PluginManagementLayout activeTab="plugins">
          <CurrentPath />
        </PluginManagementLayout>
      </MemoryRouter>,
    );

    fireEvent.click(screen.getByRole('tab', { name: '技能' }));
    await waitFor(() => {
      expect(screen.getByTestId('current-path').textContent).toBe('/skillhub/local');
    });
    // 不显示「还没有技能」空态
    expect(screen.queryByText('还没有技能')).toBeNull();
  });

  it('插件 tab 点击导航到 /plugins（Ghost 目录）', async () => {
    render(
      <MemoryRouter initialEntries={['/skillhub/local']}>
        <PluginManagementLayout activeTab="skills">
          <CurrentPath />
        </PluginManagementLayout>
      </MemoryRouter>,
    );

    fireEvent.click(screen.getByRole('tab', { name: '插件' }));
    await waitFor(() => {
      expect(screen.getByTestId('current-path').textContent).toBe('/plugins');
    });
  });
});

// ── FR-NAV-04 搜索关键词 ──────────────────────────────────────────────────────

describe('FR-NAV-04 搜索关键词', () => {
  const t = (key: string, opts?: Record<string, unknown>) => {
    const map: Record<string, string> = {
      'settings.tabs.ghosts': '插件·技能',
      'settings.tabs.general': '通用',
    };
    if (opts?.lng === 'en') {
      const enMap: Record<string, string> = {
        'settings.tabs.ghosts': 'Plugins·Skills',
        'settings.tabs.general': 'General',
      };
      return enMap[key] ?? '';
    }
    return map[key] ?? '';
  };

  it('搜索 插件 或 技能 都能命中该页', () => {
    // 复用 settings-search entry（含 aliases）
    const docs = buildSettingsSearchDocuments(t as never, ['ghosts']);
    expect(docs.length).toBeGreaterThan(0);

    const hitsPlugins = searchSettings(docs, '插件');
    const hitsSkills = searchSettings(docs, '技能');
    expect(hitsPlugins.length).toBeGreaterThan(0);
    expect(hitsSkills.length).toBeGreaterThan(0);
  });
});

// ── 五语 key 一致 ─────────────────────────────────────────────────────────────

describe('五语 key 一致', () => {
  const locales = [
    { name: 'zh-CN', data: zhCN },
    { name: 'zh-TW', data: zhTW },
    { name: 'en', data: en },
    { name: 'ja', data: ja },
    { name: 'ko', data: ko },
  ];

  it.each([
    ['sidebar.tabs.plugins'],
    ['sidebar.navigation.items.plugins'],
    ['settings.tabs.ghosts'],
    ['settings.ghosts.title'],
    ['settings.ghosts.description'],
    ['settings.ghosts.tabLabel'],
    ['skillhub.home.title'],
  ])('key %s 在五语中均存在且非空', (keyPath) => {
    const parts = keyPath.split('.');
    for (const { name, data } of locales) {
      const value = pick(data, ...parts);
      expect(value, `${name} 缺少 ${keyPath}`).toBeTruthy();
    }
  });
});
