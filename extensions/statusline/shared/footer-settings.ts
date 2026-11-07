import { readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";

export const FOOTER_SETTINGS_CHANNEL = "custom-footer:settings-changed";
const SETTINGS_PATH = `${homedir()}/.pi/agent/cc-my-pi-footer.json`;

export const FOOTER_ITEMS = {
  model: { label: "模型", icon: "◇" },
  thinking: { label: "思考等级", icon: "◈" },
  subscription: { label: "订阅用量", icon: "◷" },
  context: { label: "上下文", icon: "▣" },
  cost: { label: "费用", icon: "$" },
  speed: { label: "生成速度", icon: "↯" },
  cache: { label: "缓存命中", icon: "↻" },
  memory: { label: "记忆状态", icon: "◉" },
  legacyCodex: { label: "其他 Codex 状态", icon: "◷" },
  caveman: { label: "Caveman 状态", icon: "◆" },
  terminals: { label: "后台终端", icon: "▸" },
  mcp: { label: "MCP 状态", icon: "⌘" },
} as const;
export type FooterItemKey = keyof typeof FOOTER_ITEMS;
export type FooterConfig = Record<FooterItemKey, { enabled: boolean; icon: string }>;

export function readFooterConfig(): FooterConfig {
  let raw: any = {};
  try { raw = JSON.parse(readFileSync(SETTINGS_PATH, "utf8")); } catch (error: any) {
    if (error?.code !== "ENOENT") throw new Error(`无法读取底栏配置: ${error.message}`);
  }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("底栏配置必须是 JSON 对象");
  return Object.fromEntries(Object.entries(FOOTER_ITEMS).map(([key, item]) => {
    const value = raw[key];
    return [key, {
      enabled: typeof value?.enabled === "boolean" ? value.enabled : true,
      icon: typeof value?.icon === "string" && !/[\x00-\x1f\x7f-\x9f]/u.test(value.icon) && [...value.icon].length <= 8 ? value.icon : item.icon,
    }];
  })) as FooterConfig;
}

export async function openFooterSettings(ctx: any, pi: any): Promise<void> {
  if (!ctx.hasUI) { ctx.ui.notify("底栏设置需要交互界面", "error"); return; }
  for (;;) {
    let config: FooterConfig;
    try { config = readFooterConfig(); } catch (error: any) { ctx.ui.notify(error.message, "error"); return; }
    const keys = Object.keys(FOOTER_ITEMS) as FooterItemKey[];
    const choices = keys.map((key) => `${config[key].enabled ? "●" : "○"} ${FOOTER_ITEMS[key].label}  [${config[key].icon || "无图标"}]`);
    const selected = await ctx.ui.select("底栏设置 · 选择项目", choices);
    const index = choices.indexOf(selected);
    if (index < 0) return;
    const key = keys[index];
    const action = await ctx.ui.select(FOOTER_ITEMS[key].label, [config[key].enabled ? "隐藏" : "显示", "修改图标", "恢复默认图标"]);
    if (!action) continue;
    if (action === "隐藏" || action === "显示") config[key].enabled = action === "显示";
    else if (action === "恢复默认图标") config[key].icon = FOOTER_ITEMS[key].icon;
    else {
      const icon = await ctx.ui.input("输入图标（最多 8 个字符，留空表示无图标）", config[key].icon);
      if (icon === undefined) continue;
      if ([...icon].length > 8 || /[\x00-\x1f\x7f-\x9f]/u.test(icon)) { ctx.ui.notify("图标最多 8 个字符，不能包含控制字符", "error"); continue; }
      config[key].icon = icon;
    }
    try {
      writeFileSync(SETTINGS_PATH, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
      pi.events.emit(FOOTER_SETTINGS_CHANNEL, undefined);
    } catch (error: any) { ctx.ui.notify(`保存底栏设置失败: ${error.message}`, "error"); return; }
  }
}
