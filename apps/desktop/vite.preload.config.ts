import { defineConfig } from 'vite';

export default defineConfig({
  // preload / utilityProcess bundle 跑在 Node/Electron 运行期,`process.env` 必须保持
  // 运行时读取。Vite 对非 lib 构建默认把 `process.env` 内联成 `{}`（definePlugin 的
  // client 安全策略）,而 forge 的 preload target 恰好走 `build.rollupOptions.input`
  // 而非 `build.lib`（插件模板注释：preload 可能带 web 资源）,于是
  // `process.env.XDT_UI_MOCK` 这类投影在 bundle 里被替换成空对象、永远 undefined。
  // `keepProcessEnv` 关掉该内联；`process.env.NODE_ENV` 仍会被单独 define,不影响
  // 死代码消除。
  environments: {
    client: {
      keepProcessEnv: true,
    },
  },
  build: {
    rollupOptions: {
      // preload.ts 用 `import('../main/...')` 仅取类型,Rollup 分析时仍会跟进
      // skillhub/scanner → gray-matter,触发 gray-matter JS 引擎里那段 eval 的警告。
      // 实际 bundle 已 tree-shake 掉 gray-matter (preload 运行期不依赖),警告纯噪音。
      // 只屏蔽这一处,保留对其他新增 eval 的告警能力。
      onwarn(warning, defaultHandler) {
        if (
          warning.code === 'EVAL' &&
          typeof warning.id === 'string' &&
          warning.id.replace(/\\/g, '/').includes('/gray-matter/lib/engines.js')
        ) {
          return;
        }
        defaultHandler(warning);
      },
    },
  },
});
