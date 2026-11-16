import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { stripVTControlCharacters as clean } from "node:util";

const require = createRequire(import.meta.url);
const { createJiti } = require("jiti");
const root = dirname(fileURLToPath(import.meta.url));
const fixture = mkdtempSync(join(tmpdir(), "cc-my-pi-xs-test-"));
process.env.HOME = fixture;
mkdirSync(join(fixture, ".pi"));
mkdirSync(join(fixture, "project"));
process.chdir(join(fixture, "project"));
const settingsPath = join(homedir(), ".pi/settings.json");
writeFileSync(settingsPath, JSON.stringify({ conversationStyle: "devin", unrelated: "preserve" }));
const bootstrap = createJiti(import.meta.url);
const hostPath = process.env.PI_TEST_HOST || bootstrap.resolve("@earendil-works/pi-coding-agent");
const tuiPath = require.resolve("@earendil-works/pi-tui", { paths: [dirname(hostPath)] });
// Match Pi's extension loader: one host copy, including its own TUI classes.
const load = createJiti(import.meta.url, { alias: {
  "@earendil-works/pi-coding-agent": hostPath,
  "@earendil-works/pi-tui": tuiPath,
} });
const host = load(hostPath), tui = load(tuiPath);
host.initTheme("dark");
const theme = globalThis[Symbol.for("@earendil-works/pi-coding-agent:theme")];
const view = load(join(root, "devin-view.ts"));
const ui = load(join(root, "cc-my-pi-settings-ui.ts"));
const telemetry = load(join(root, "statusline/model-info/telemetry.ts"));
const events = new EventEmitter(), commands = new Map(), tools = new Map();
const pi = new Proxy({
  events: { on: (n, f) => { events.on(n, f); return () => events.off(n, f); }, emit: (n, v) => events.emit(n, v) },
  on: () => () => {}, registerCommand: (n, c) => commands.set(n, c), registerTool: (t) => tools.set(t.name, t),
  getFlag: () => false, getActiveTools: () => [], getAllTools: () => [...tools.values()], getThinkingLevel: () => "high",
}, { get: (target, key) => key in target ? target[key] : () => {} });
await load(join(root, "index.ts")).default(pi);
const rows = (c, width = 100) => c.render(width).map(clean).map((s) => s.trimEnd());
const message = (content) => ({ role: "assistant", content, stopReason: "stop", usage: { output: 100, totalTokens: 100, cost: { total: 0 } } });
const makeTool = (name, args, details = {}, text = "ok") => {
  const component = new host.ToolExecutionComponent(name, name, args, {}, tools.get(name), { requestRender() {} }, process.cwd());
  component.updateResult({ content: [{ type: "text", text }], details, isError: false });
  return component;
};
const askArgs = { questions: [{ id: "release", prompt: "发布前需要人工校对吗？", options: [
  { value: "manual", label: "人工确认" }, { value: "auto", label: "UNSELECTED" },
] }] };
const askDetails = { mode: "submit", cancelled: false, questions: askArgs.questions, answers: {
  release: { indices: [0], labels: ["人工确认"], values: ["manual"], note: "先预览再发布", optionNotes: { manual: "保留人工修改" } },
} };

test("process summaries distinguish background submission from completion", () => {
  const args = { action: "start", name: "cold-floor-retry", command: "DO_NOT_SHOW_COMMAND" };
  const tool = { toolName: "process", args, result: { content: [], details: {} }, isPartial: false };
  assert.equal(view.devinToolSummary(tool), "Submitted to background · cold-floor-retry");
  const submitted = view.renderDevinTool(tool, 100, theme).map(clean).join("\n");
  assert.match(submitted, /↗ Submitted to background/);
  assert(!submitted.includes("✓"));
  assert(!submitted.includes(args.command));
  assert.match(rows(makeTool("process", args)).join("\n"), /↗ Submitted to background/);
  for (const action of ["list", "output", "stop", "update", "write", "clear"]) {
    const summary = view.devinToolSummary({ ...tool, args: { action, id: "proc_1" } });
    assert(!summary.startsWith("process"));
    assert(summary.includes("background"));
  }
  const failed = { ...tool, result: { isError: true, content: [{ type: "text", text: "spawn failed" }] } };
  assert.match(view.renderDevinTool(failed, 100, theme).map(clean).join("\n"), /×.*\n.*spawn failed/);
  const pending = { ...tool, result: undefined, executionStarted: true, isPartial: true };
  assert(!view.devinToolSummary(pending).includes("Submitted"));
});

const processNotification = (label = "Log match", onClick = () => {}, customType = "ad-process:notification") => new host.CustomMessageComponent(
  { role: "custom", customType, content: label, display: true, timestamp: 0 },
  (_message, options) => {
    const body = new tui.Container();
    body.addChild(new tui.Text(label, options.outputPad ?? 0, 0));
    if (options.expanded) {
      body.addChild(new tui.Spacer(1));
      body.addChild(new tui.Text("Preserved expanded detail", 0, 0));
    }
    body.handleMouse = (event) => { onClick(event); return { handled: true }; };
    return body;
  },
);

test("consecutive process notifications have no blank rows and preserve expanded click layout", () => {
  const parent = new tui.Container();
  let clicked;
  const first = processNotification(), second = processNotification("Completed", (event) => { clicked = event; });
  parent.addChild(first); parent.addChild(second);
  assert.equal(rows(first).length, 1);
  assert.deepEqual(rows(second).map((line) => line.trim()), ["Completed"]);
  assert.equal(rows(parent).filter((line) => !line.trim()).length, 0);
  second.handleMouse({ type: "click", button: "left", x: 2, y: 0, screenX: 2, screenY: 2, width: 100, height: 1, shift: false, alt: false, ctrl: false });
  assert.equal(clicked?.y, 0);
  second.setExpanded(true);
  assert.deepEqual(rows(second).map((line) => line.trim()), ["Completed", "", "Preserved expanded detail"]);
});

test("process spacing stays compact across neighbors and preserves unrelated custom messages", () => {
  const parent = new tui.Container(), first = processNotification(), second = processNotification("Completed");
  assert.equal(rows(second).length, 1); // Warm the standalone custom-message cache.
  parent.addChild(first); parent.addChild(second);
  assert.equal(rows(second).length, 1);
  parent.removeChild(first);
  assert.equal(rows(second).length, 1);
  parent.removeChild(second); parent.addChild(first);
  const unrelated = processNotification("Unrelated note", () => {}, "other:notification");
  parent.addChild(unrelated); parent.addChild(second);
  assert.equal(rows(unrelated)[0], "");
  assert.equal(rows(second).length, 1);
  parent.removeChild(unrelated);
  assert.equal(rows(second).length, 1);
  const hidden = new host.AssistantMessageComponent(message([{ type: "thinking", thinking: "hidden" }]), true);
  parent.removeChild(second); parent.addChild(hidden); parent.addChild(second);
  assert.equal(rows(second).length, 1);
  hidden.setHideThinkingBlock(false);
  assert.equal(rows(second)[0], "");
  hidden.setHideThinkingBlock(true);
  assert.equal(rows(second).length, 1);
});

test("activity rows stay compact and assistant prose has one blank line on each side", () => {
  const prose = () => new host.AssistantMessageComponent(message([{ type: "text", text: "Status update." }]), true);
  const tool = () => makeTool("read", { path: "status.json" }, {}, "ok");
  for (const before of [prose, tool]) {
    for (const after of [prose, tool]) {
      const parent = new tui.Container();
      parent.addChild(before()); parent.addChild(new tui.Spacer(1));
      parent.addChild(processNotification()); parent.addChild(new tui.Spacer(1)); parent.addChild(after());
      const lines = rows(parent);
      assert(lines.some((line) => line.includes("Log match")));
      const index = lines.findIndex((line) => line.includes("Log match"));
      assert.equal(lines[index - 1] === "", before === prose);
      assert.equal(lines[index + 1] === "", after === prose);
      assert.equal(lines.filter((line) => !line.trim()).length, Number(before === prose) + Number(after === prose));
    }
  }
});

test("a process event after prose keeps its leading row in mouse layout", () => {
  const parent = new tui.Container();
  let clicked;
  parent.addChild(new host.AssistantMessageComponent(message([{ type: "text", text: "Status update." }]), true));
  const event = processNotification("Completed", (mouse) => { clicked = mouse; });
  parent.addChild(event);
  assert.deepEqual(rows(event).map((line) => line.trim()), ["", "Completed"]);
  event.handleMouse({ type: "click", button: "left", x: 2, y: 1, screenX: 2, screenY: 2, width: 100, height: 2, shift: false, alt: false, ctrl: false });
  assert.equal(clicked?.y, 0);
});

test("process boundaries preserve blank lines inside assistant prose", () => {
  const content = message([{ type: "text", text: "First paragraph.\n\nSecond paragraph." }]);
  const baseline = rows(new host.AssistantMessageComponent(content, true));
  const parent = new tui.Container(), assistant = new host.AssistantMessageComponent(content, true);
  parent.addChild(processNotification()); parent.addChild(new tui.Spacer(1)); parent.addChild(assistant);
  assert.deepEqual(rows(assistant), ["", ...baseline]);
  const last = processNotification("Completed");
  parent.addChild(new tui.Spacer(1)); parent.addChild(last);
  assert.deepEqual(rows(last).map((line) => line.trim()), ["", "Completed"]);
  assert.equal(rows(parent).length, baseline.length + 4);
});

test("read ranges, edit counts and multiline shell summaries stay compact", () => {
  const read = makeTool("read", { path: join(process.cwd(), "sample.ts"), offset: 20, limit: 3 }, {}, "a\nb\nc");
  assert.equal(view.devinToolSummary(read), "Read lines 20-22 in ./sample.ts 3 lines");
  assert.equal(view.devinToolSummary(makeTool("edit", { path: "sample.ts" }, { added: 16, removed: 2 })), "Edited sample.ts +16 -2");
  assert.equal(view.devinToolSummary({ toolName: "bash", args: { command: "python - <<'PY'\nprint(1)\nPY" } }), "python - <<'PY' (+2 lines)");
  const colors = [];
  view.renderDevinTool(read, 100, { fg: (tone, text) => { colors.push(tone); return text; } });
  assert(!colors.includes("text"));
});

test("tool type colors use a fixed palette without recoloring semantic roles", () => {
  const names = ["read", "bash", "edit", "write", "grep", "find", "ls", "apply_patch", "process", "ask_user"];
  assert.equal(new Set(names.map(view.toolTypeColor)).size, names.length);
  assert.equal(view.toolTypeColor("shell"), view.toolTypeColor("bash"));
  for (const name of ["mcp_lookup", "constructor", "__proto__"]) {
    assert.match(view.toolTypeColor(name), /^#[0-9a-f]{6}$/);
    assert.equal(view.toolTypeColor(name), view.toolTypeColor(name));
  }
  const colored = view.toolCallColorTheme(theme, "read");
  assert.equal(colored, view.toolCallColorTheme(theme, "read"));
  assert.equal(colored.fg("toolTitle", "Read"), view.colorToolText("read", "Read"));
  assert.equal(colored.fg("accent", "src/app.ts"), view.colorToolText("read", "src/app.ts"));
  assert.equal(colored.fg("toolTitle", theme.bold("Read")), view.colorToolText("read", theme.bold("Read")));
  for (const [tone, text] of [["success", "+16"], ["error", "-2"], ["warning", "warning"], ["accent", "●"], ["muted", "output"], ["dim", "context"]]) {
    assert.equal(colored.fg(tone, text), theme.fg(tone, text));
  }
  const otherTheme = { fg: (tone, text) => `${tone}:${text}` };
  assert.equal(view.toolCallColorTheme(otherTheme, "read").fg("toolTitle", "Read"), colored.fg("toolTitle", "Read"));
  assert.equal(clean(view.colorToolText("read", theme.fg("muted", "src/app.ts"))), "src/app.ts");
});

test("Devin tool colors preserve text, statuses, diff counts, errors and narrow widths", () => {
  const samples = [
    makeTool("read", { path: "sample.ts" }),
    makeTool("bash", { command: "npm test" }),
    makeTool("edit", { path: "sample.ts" }, { added: 16, removed: 2 }),
    { toolName: "process", args: { action: "start", name: "retry" }, result: { content: [], details: {} }, isPartial: false },
  ];
  for (const tool of samples) {
    const original = view.renderDevinTool(tool, 100, theme);
    assert.deepEqual(view.renderDevinTool(tool, 100, theme, false), original);
    const colored = view.renderDevinTool(tool, 100, theme, true);
    assert.deepEqual(colored.map(clean), original.map(clean));
    assert(colored.join("\n").includes(view.colorToolText(tool.toolName, "COLOR").split("COLOR")[0]));
    for (const width of [1, 8, 20, 80]) assert(view.renderDevinTool(tool, width, theme, true).every((line) => tui.visibleWidth(line) <= width));
  }
  const edit = view.renderDevinTool(samples[2], 100, theme, true)[0];
  assert(edit.includes(theme.fg("success", " +16")));
  assert(edit.includes(theme.fg("error", " -2")));
  const failed = { ...samples[1], result: { isError: true, content: [{ type: "text", text: "Test failed" }] } };
  const before = view.renderDevinTool(failed, 100, theme), after = view.renderDevinTool(failed, 100, theme, true);
  assert.equal(after[1], before[1]);
  assert(after[0].startsWith(` ${theme.fg("error", "×")} `));
});

test("ask details retain questions, answers and notes, never unselected options", () => {
  const tool = makeTool("ask_user", askArgs, askDetails, "release: 人工确认");
  const before = JSON.stringify(tool.result);
  const text = rows(tool).join("\n");
  for (const part of ["问题 1：发布前需要人工校对吗？", "回答：人工确认", "备注：先预览再发布", "选项备注（人工确认）：保留人工修改"]) assert(text.includes(part));
  assert(!text.includes("UNSELECTED"));
  assert.equal(JSON.stringify(tool.result), before);
  for (const width of [1, 10, 25, 80]) assert(tool.render(width).every((s) => tui.visibleWidth(s) <= width));
  const cancelled = { ...tool, result: { details: { ...askDetails, cancelled: true }, content: [{ type: "text", text: "User cancelled." }] } };
  assert(view.renderDevinAskUserDetails(cancelled, 100, theme).join("\n").includes("User cancelled."));
  assert.deepEqual(view.renderDevinAskUserDetails({ ...tool, isPartial: true }, 100, theme), []);
});

test("long user messages fold to six rows; control clicks preserve text and selection", () => {
  const parent = new tui.Container(), source = Array.from({ length: 30 }, (_, i) => `第 ${i + 1} 行：示例文本`).join("\n");
  const user = new host.UserMessageComponent(source);
  parent.addChild(user);
  let lines = rows(user);
  assert.equal(lines.length, 7);
  assert(lines[6].includes("展开剩余 24 行"));
  const event = { type: "click", button: "left", x: 3, y: 6, screenX: 3, screenY: 6, width: 100, height: 7, shift: false, alt: false, ctrl: false, clickCount: 1 };
  for (const type of ["press", "drag", "wheel"]) assert.equal(user.handleMouse({ ...event, type }), undefined);
  assert.equal(user.handleMouse({ ...event, y: 2 }), undefined);
  assert(user.handleMouse(event)?.handled);
  lines = rows(user);
  assert.equal(lines.length, 31);
  assert(lines.at(-1).includes("收起"));
  assert(user.handleMouse({ ...event, y: 30, height: 31 })?.handled);
  assert.equal(rows(user).length, 7);
  assert.equal(user.text, source);
  const rendered = user.render(100).join("\n");
  for (const marker of ["A", "B", "C"]) assert.equal(rendered.split(`\x1b]133;${marker}\x07`).length - 1, 1);
  const wide = new host.UserMessageComponent("中文".repeat(300));
  for (const width of [1, 10, 30, 100]) assert(wide.render(width).every((s) => tui.visibleWidth(s) <= width));
});

test("hidden thinking leaves no historical rows; Ctrl+T still reveals its contents", () => {
  const component = new host.AssistantMessageComponent(message([{ type: "thinking", thinking: "preserved reasoning" }]), true);
  assert.deepEqual(rows(component), []);
  component.setHideThinkingBlock(false);
  assert(rows(component).join("\n").includes("preserved reasoning"));
  component.setHideThinkingBlock(true);
  assert.deepEqual(rows(component), []);
});

test("default-on ask setting persists off/on through the real settings panel", async () => {
  const tool = makeTool("ask_user", askArgs, askDetails);
  let panel;
  const ctx = { mode: "tui", hasUI: true, ui: {
    theme, custom: async (factory) => { panel = factory({}, theme, {}, () => {}); },
    getToolsExpanded: () => false, setToolsExpanded() {}, invalidate() {}, requestRender() {}, notify() {},
  } };
  await commands.get("cc-my-pi").handler("", ctx);
  assert(panel.render(120).map(clean).join("\n").includes("Ask User details"));
  panel.handleInput("\x1b[B"); panel.handleInput("\x1b[B"); panel.handleInput("\r");
  assert.equal(JSON.parse(readFileSync(settingsPath, "utf8")).devinAskUserDetails, false);
  assert.equal(rows(tool).length, 1);
  tool.setExpanded(true);
  assert(rows(tool).join("\n").includes("问题 1："));
  tool.setExpanded(false);
  panel.handleInput("\r");
  const saved = JSON.parse(readFileSync(settingsPath, "utf8"));
  assert.equal(saved.devinAskUserDetails, true); assert.equal(saved.unrelated, "preserve");
  assert(rows(tool).join("\n").includes("问题 1："));
  assert.equal(ui.SETTING_ORDER.find((s) => s.id === "devinAskUserDetails").current({}), "on");
});

test("tool type colors default off and toggle live in both styles through settings", async () => {
  const definition = ui.SETTING_ORDER.find((s) => s.id === "toolTypeColors");
  assert.equal(definition.current({}), "off");
  assert(!Object.hasOwn(JSON.parse(readFileSync(settingsPath, "utf8")), "toolTypeColors"));
  const samples = [makeTool("read", { path: "src/app.ts", offset: 1, limit: 2 }), makeTool("bash", { command: "npm test" })];
  const baseline = samples.map((tool) => rows(tool));
  const baselineCalls = samples.map((tool) => tool.callRendererComponent.render(100));
  const baselineResults = samples.map((tool) => tool.resultRendererComponent.render(100));
  let panel;
  const ctx = { mode: "tui", hasUI: true, ui: {
    theme, custom: async (factory) => { panel = factory({}, theme, {}, () => {}); },
    getToolsExpanded: () => false, setToolsExpanded(expanded) { samples.forEach((tool) => tool.setExpanded(expanded)); },
    invalidate() {}, requestRender() {}, notify() {},
  } };
  await commands.get("cc-my-pi").handler("", ctx);
  assert(panel.render(120).map(clean).join("\n").includes("Tool type colors"));
  for (let i = 0; i < 3; i++) panel.handleInput("\x1b[B");
  panel.handleInput("\r");
  assert.equal(JSON.parse(readFileSync(settingsPath, "utf8")).toolTypeColors, true);
  for (const [index, tool] of samples.entries()) {
    assert.deepEqual(rows(tool), baseline[index]);
    const prefix = view.colorToolText(tool.toolName, "COLOR").split("COLOR")[0];
    assert(tool.render(100).join("\n").includes(prefix));
    assert(tool.callRendererComponent.render(100).join("\n").includes(prefix));
    assert.deepEqual(tool.resultRendererComponent.render(100), baselineResults[index]);
    tool.setExpanded(true);
    assert(tool.render(100).join("\n").includes(prefix));
    tool.setExpanded(false);
  }
  // Conversation style is two rows above Tool type colors (after the footer row).
  panel.handleInput("\x1b[A"); panel.handleInput("\x1b[A"); panel.handleInput("\r");
  assert.equal(JSON.parse(readFileSync(settingsPath, "utf8")).conversationStyle, "claude");
  for (const tool of samples) {
    assert(tool.render(100).join("\n").includes(view.colorToolText(tool.toolName, "COLOR").split("COLOR")[0]));
  }
  panel.handleInput("\x1b[B"); panel.handleInput("\x1b[B"); panel.handleInput("\r");
  assert.equal(JSON.parse(readFileSync(settingsPath, "utf8")).toolTypeColors, false);
  samples.forEach((tool, index) => assert.deepEqual(tool.callRendererComponent.render(100), baselineCalls[index]));
  panel.handleInput("\x1b[A"); panel.handleInput("\x1b[A"); panel.handleInput("\r");
  const saved = JSON.parse(readFileSync(settingsPath, "utf8"));
  assert.equal(saved.conversationStyle, "devin"); assert.equal(saved.unrelated, "preserve");
  samples.forEach((tool, index) => assert.deepEqual(rows(tool), baseline[index]));
});

test("hooks survive reinstall and preserve normal-mode fallback", () => {
  const user = new host.UserMessageComponent(Array(20).fill("sample").join("\n"));
  const options = { enabled: () => true, theme: () => theme };
  view.installDevinView(options); view.installDevinView(options);
  assert(rows(user).at(-1).includes("展开剩余"));
  view.installDevinView({ ...options, enabled: () => false });
  assert(!rows(user).some((line) => line.includes("展开剩余")));
  assert(rows(user).length >= 20);
  const parent = new tui.Container(), first = processNotification(), second = processNotification("Completed");
  parent.addChild(first); parent.addChild(second);
  assert.equal(rows(second)[0], "");
  view.installDevinView(options); view.installDevinView(options);
  assert.equal(rows(second).length, 1);
  view.installDevinView({ ...options, enabled: () => false });
  assert.equal(rows(second)[0], "");
  view.installDevinView(options);
  assert.equal(rows(second).length, 1);
});

test("telemetry uses CJK-aware live estimates and excludes tool gaps from final rate", () => {
  assert.equal(telemetry.estimateDeltaTokens("中文abcd"), 3);
  let now = 0;
  const tracker = new telemetry.TurnTelemetryTracker(() => now);
  const msg = message([{ type: "text", text: "demo" }]);
  tracker.handle({ type: "agent_start" });
  const turn = () => {
    tracker.handle({ type: "turn_start" }); tracker.handle({ type: "message_start", message: msg });
    now += 100;
    tracker.handle({ type: "message_update", message: msg, assistantMessageEvent: { type: "text_delta", delta: "aaaa" } });
    now += 400;
    tracker.handle({ type: "message_update", message: msg, assistantMessageEvent: { type: "thinking_delta", delta: "bbbb" } });
    assert.equal(tracker.getLiveTps().tps, 2.5);
    now += 500;
    tracker.handle({ type: "message_end", message: msg }); tracker.handle({ type: "turn_end" });
  };
  turn(); now += 10_000; turn();
  assert.equal(tracker.handle({ type: "agent_settled" }).tps, 100);
});

test("footer defaults and package identity preserve independent-fork boundaries", () => {
  const { readFooterConfig } = load(join(root, "statusline/shared/footer-settings.ts"));
  assert.equal(readFooterConfig().model.icon, "◇");
  assert.equal(readFooterConfig().speed.enabled, true);
  const pkg = JSON.parse(readFileSync(join(root, "../package.json"), "utf8"));
  assert.equal(pkg.name, "cc-my-pi-xs"); assert.equal(pkg.private, true);
  assert.equal(load(join(root, "update-check.ts")).installedVersion(root), undefined);
});
