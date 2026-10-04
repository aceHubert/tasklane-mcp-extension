/**
 * 构建 Codex 插件 bundle → plugins/tasklane/
 *
 * 产物（自包含，安装时 Codex 只拷贝该目录，无需 node_modules）：
 *   plugins/tasklane/server.mjs         esbuild 打包的 MCP server（14 个业务工具 + MCP Apps widget）
 *   plugins/tasklane/kanban-widget.html 单文件看板 UI（ext-apps 浏览器 SDK 已注入 head）
 *   plugins/tasklane/assets/            图标（由 manifest 引用，随插件分发）
 *   plugins/tasklane/skills/            原生应用打开技能（由 Codex manifest 引用）
 *
 * 前置：npm run build（workspace tsc）。流程与 Codex 插件的发布构建同构：
 *   vite build → 内联 HTML → 注入 MCP Apps 全局脚本 → esbuild bundle server
 */
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build as esbuild } from "esbuild";
import { build as viteBuild } from "vite";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const TOOLS_DIR = path.join(ROOT, "extension", "tools");
const require = createRequire(path.join(TOOLS_DIR, "package.json"));

const MCP_SERVER_DIST = path.join(ROOT, "mcp", "dist", "src", "server.js");
const CORE_DIST = path.join(ROOT, "packages", "core", "dist");
const UI_DIR = path.join(ROOT, "ui");
const ASSETS_DIR = path.join(ROOT, "extension", "assets");
const PLUGIN_DIR = path.join(ROOT, "plugins", "tasklane");

const GLOBAL_NAME = "__KANBAN_MCP_APPS__";

function assertPrerequisites() {
  for (const target of [MCP_SERVER_DIST, CORE_DIST]) {
    if (!existsSync(target)) {
      throw new Error(`Missing ${path.relative(ROOT, target)}. Run "npm run build" first.`);
    }
  }
  const extApps =(() => { try { return require.resolve("@modelcontextprotocol/ext-apps/app-with-deps"); } catch { return null; } })();
  if (!extApps) {
    throw new Error("Missing build dep @modelcontextprotocol/ext-apps. Run npm install in extension/tools/.");
  }
  return extApps;
}

/** 从 ext-apps 浏览器构建里提取 SDK，暴露为全局（早于 UI bundle 执行） */
function buildMcpAppsGlobalScript(sourcePath) {
  const source = readFileSync(sourcePath, "utf8");
  const exportStart = source.lastIndexOf("export{");
  if (exportStart === -1) throw new Error("Could not find the ext-apps browser export block.");
  const match = source.slice(exportStart).match(/^export\{([^}]+)\};?\s*$/s);
  if (!match) throw new Error("Could not parse the ext-apps browser export block.");
  const exportMap = parseExportMap(match[1]);
  const required = ["App"];
  for (const name of required) {
    if (!exportMap.has(name)) throw new Error(`Missing ext-apps browser export: ${name}`);
  }
  return [
    source.slice(0, exportStart),
    `;globalThis.${GLOBAL_NAME}={App:${exportMap.get("App")}};`,
  ].join("");
}

function parseExportMap(body) {
  const map = new Map();
  for (const raw of body.split(",")) {
    const entry = raw.trim();
    if (!entry) continue;
    const parts = entry.split(/\s+as\s+/);
    const local = parts[0]?.trim();
    const exported = (parts[1] || parts[0])?.trim();
    if (local && exported) map.set(exported, local);
  }
  return map;
}

/** vite 产物 → 单文件 HTML（样式/脚本内联，移除 modulepreload） */
async function buildWidgetHtml(outDir) {
  let html = readFileSync(path.join(outDir, "index.html"), "utf8");
  const inlineScripts = [];

  html = html.replace(/<link\s+rel="modulepreload"[^>]+href="([^"]+)"[^>]*>\s*/g, "");
  // favicon / touch-icon 在 ui:// 单文件环境无法解析到相邻文件（插件包也不携带），直接剥离
  html = html.replace(/<link\s+rel="(?:icon|apple-touch-icon|manifest)"[^>]*>\s*/g, "");
  html = html.replace(
    /<link\s+rel="stylesheet"[^>]+href="([^"]+)"[^>]*>/g,
    (_m, href) => `<style>\n${readFileSync(path.join(outDir, href.replace(/^\//, "")), "utf8")}\n</style>`,
  );
  html = html.replace(
    /<script\s+type="module"[^>]+src="([^"]+)"[^>]*><\/script>/g,
    (_m, src) => {
      const js = readFileSync(path.join(outDir, src.replace(/^\//, "")), "utf8");
      // 内联为经典 script（宿主 CSP 已验证可用）；bundle 里出现 import.meta 会直接语法错误
      if (/import\.meta/.test(js)) {
        throw new Error(
          "Widget bundle references import.meta — classic inline script cannot parse it. " +
            "Use static asset imports (inlined as data URLs) instead of new URL(..., import.meta.url).",
        );
      }
      inlineScripts.push(`<script>\n(() => {\n${escapeClosingScript(js)}\n})();\n</script>`);
      return "";
    },
  );

  if (/\b(?:src|href)\s*=\s*"[^"]*\/assets\//i.test(html)) {
    throw new Error("Widget HTML still references external build assets.");
  }
  if (inlineScripts.length > 0) {
    html = html.replace("</body>", () => `${inlineScripts.join("\n")}\n</body>`);
  }
  return html;
}

function escapeClosingScript(source) {
  return source.replaceAll("</script", "<\\/script").replaceAll("</SCRIPT", "<\\/SCRIPT");
}

function injectHead(html, headSnippet) {
  const tag = `<script>${escapeClosingScript(headSnippet)}</script>`;
  return html.includes("</head>") ? html.replace("</head>", () => `${tag}\n</head>`) : `${tag}\n${html}`;
}

async function main() {
  const extAppsPath = assertPrerequisites();
  console.log("[build-plugin] 1/4 vite build (ui)…");
  const viteOut = path.join(ROOT, "extension", "dist", "widget-build");
  rmSync(viteOut, { recursive: true, force: true });
  await viteBuild({
    root: UI_DIR,
    logLevel: "warn",
    build: { outDir: viteOut, emptyOutDir: true },
  });

  console.log("[build-plugin] 2/4 inline widget html + inject MCP Apps global…");
  const mcpAppsGlobal = buildMcpAppsGlobalScript(extAppsPath);
  let widgetHtml = await buildWidgetHtml(viteOut);
  widgetHtml = injectHead(widgetHtml, mcpAppsGlobal);
  if (!widgetHtml.includes(GLOBAL_NAME)) {
    throw new Error("Widget HTML is missing the MCP Apps global script.");
  }

  console.log("[build-plugin] 3/4 esbuild bundle plugin server…");
  const serverBundle = path.join(ROOT, "extension", "dist", "server.mjs");
  await esbuild({
    entryPoints: [path.join(ROOT, "extension", "src", "plugin-server.mjs")],
    outfile: serverBundle,
    bundle: true,
    platform: "node",
    format: "esm",
    target: "node20",
    charset: "utf8",
    minify: true,
    legalComments: "eof",
    treeShaking: true,
    logLevel: "warning",
    // ext-apps 装在隔离的 extension/tools/node_modules（zod peer 兼容 workspace，sdk 走自带副本）
    nodePaths: [path.join(TOOLS_DIR, "node_modules")],
  });

  console.log("[build-plugin] 4/4 assemble plugins/tasklane/…");
  // 只覆盖明确的构建产物，保留插件目录中其他未提交文件。
  mkdirSync(path.join(PLUGIN_DIR, "assets"), { recursive: true });
  cpSync(serverBundle, path.join(PLUGIN_DIR, "server.mjs"));
  writeFileSync(path.join(PLUGIN_DIR, "kanban-widget.html"), widgetHtml);
  // 插件 manifest 引用的图标随插件分发；原始大图不入包
  for (const name of ["logo-16.png", "logo-32.png", "logo-128.png", "logo-256.png", "sidebar-icon.svg"]) {
    const src = path.join(ASSETS_DIR, name);
    if (!existsSync(src)) throw new Error(`Missing plugin asset: ${name}`);
    cpSync(src, path.join(PLUGIN_DIR, "assets", name));
  }
  // manifest（.codex-plugin/plugin.json、.mcp.json、plugin.json）由仓库维护，直接复制
  for (const rel of [["plugin.json"], ["mcp.json"], [".mcp.json"], [".codex-plugin", "plugin.json"]]) {
    const src = path.join(ROOT, "extension", "plugin-src", ...rel);
    const dest = path.join(PLUGIN_DIR, ...rel);
    if (!existsSync(src)) throw new Error(`Missing plugin manifest: ${rel.join("/")}`);
    mkdirSync(path.dirname(dest), { recursive: true });
    cpSync(src, dest);
  }
  for (const name of ["open-tasklane", "native-execution"]) {
    const source = path.join(ROOT, "extension", "plugin-src", "skills", name, "SKILL.md");
    if (!existsSync(source)) throw new Error(`Missing plugin skill: skills/${name}/SKILL.md`);
    const dest = path.join(PLUGIN_DIR, "skills", name, "SKILL.md");
    mkdirSync(path.dirname(dest), { recursive: true });
    cpSync(source, dest);
  }

  const serverKb = Math.ceil(statSync(path.join(PLUGIN_DIR, "server.mjs")).size / 1024);
  const widgetKb = Math.ceil(statSync(path.join(PLUGIN_DIR, "kanban-widget.html")).size / 1024);
  console.log(`[build-plugin] done → ${path.relative(ROOT, PLUGIN_DIR)} (server ${serverKb}KB, widget ${widgetKb}KB)`);
}

main().catch((err) => {
  console.error("[build-plugin] failed:", err);
  process.exit(1);
});
