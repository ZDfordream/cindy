import type { SettingsSearchModule } from './settingsSearchTypes';

/** Static search metadata owned by this settings module; no component mounting or IPC. */
export default {
  id: 'ghosts',
  order: 13,
  entries: [
    { id: 'plugins', tab: 'ghosts', targetId: 'settings-panel-ghosts', titleKey: 'settings.tabs.ghosts', sectionKey: 'settings.tabs.ghosts', aliases: ['插件', '技能', 'plugin', 'skill'] },
  ],
} satisfies SettingsSearchModule;
