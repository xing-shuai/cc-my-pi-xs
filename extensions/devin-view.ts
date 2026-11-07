import { stripVTControlCharacters } from "node:util";
import { isAbsolute, relative } from "node:path";
import { AssistantMessageComponent, ToolExecutionComponent, UserMessageComponent, type Theme } from "@earendil-works/pi-coding-agent";
import { Spacer, Text, sliceByColumn, truncateToWidth, visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";

const PARENT = Symbol.for("pi-claude-style-tools:component-parent");
const TOOL_HOOK = Symbol.for("cc-my-pi:devin-tool-hook");
const SPACER_HOOK = Symbol.for("cc-my-pi:devin-spacer-hook");
const OLD_ASSISTANT_HOOK = Symbol.for("cc-my-pi:devin-assistant-hook");
const MESSAGE_HOOK = Symbol.for("cc-my-pi:devin-message-layout-hook");
const MESSAGE_INSTALLED = Symbol.for("cc-my-pi:devin-message-layout-installed");
const DOTTED_HOOK = Symbol.for("cc-my-pi:devin-paragraph-hook");
const MESSAGE_MODE = Symbol.for("cc-my-pi:devin-message-mode");
const MESSAGE_CACHE = Symbol.for("pi-claude-style-tools:message-render-cache");
const THINKING_HOOK = Symbol.for("cc-my-pi:devin-thinking-hook");
const THINKING_LAYOUT = Symbol.for("cc-my-pi:devin-thinking-layout");
const INSTALLED = Symbol.for("cc-my-pi:devin-installed");
const USER_EXPANDED = Symbol.for("cc-my-pi:devin-user-expanded");
const USER_FOLD = Symbol.for("cc-my-pi:devin-user-fold");
const USER_MOUSE_HOOK = Symbol.for("cc-my-pi:devin-user-mouse-hook");
const USER_MOUSE_INSTALLED = Symbol.for("cc-my-pi:devin-user-mouse-installed");
const USER_PREVIEW_LINES = 6;
const USER_FOLD_THRESHOLD = 8;
const COPY_ZONES = /\x1b\]133;[ABC](?:\x07|\x1b\\)/g;
let userMessageParent: WeakRef<any> | undefined;

type UserFoldLayout = { width: number; row: number; columns: number; total: number };
type DevinViewOptions = {
  enabled: () => boolean;
  theme: () => Theme;
  askUserDetails?: () => boolean;
  renderUserControl?: (text: string, width: number) => string;
};

type Part = { text: string; tone: "text" | "dim" | "success" | "error" };
const readCounts = new WeakMap<object, number | undefined>();

function plain(value: unknown): string {
  return stripVTControlCharacters(String(value ?? "").slice(0, 8192)).replace(/[\x00-\x1f\x7f-\x9f]/g, " ").replace(/\s+/g, " ").trim();
}

function filePath(path: unknown, cwd?: string): string {
  const value = plain(path);
  if (!cwd || !isAbsolute(value)) return value;
  const local = relative(cwd, value);
  return local && !local.startsWith("..") ? `./${local}` : value;
}

function readCount(result: any): number | undefined {
  if (!result || result.isError || result.content?.some((block: any) => block.type === "image")) return;
  if (readCounts.has(result)) return readCounts.get(result);
  const truncation = result.details?.truncation;
  let count: number | undefined;
  if (truncation?.firstLineExceedsLimit) count = undefined;
  else if (Number.isInteger(truncation?.outputLines)) count = truncation.outputLines;
  else {
    const blocks = result.content?.filter((block: any) => block.type === "text");
    if (blocks?.length) {
      const text = blocks.map((block: any) => block.text ?? "").join("\n")
        .replace(/\n\n\[(?:\d+ more lines in file\.|Showing lines )[^\n]*\]\s*$/, "");
      count = text === "" ? 0 : text.split("\n").length;
    }
  }
  readCounts.set(result, count);
  return count;
}

function editCounts(details: any): { added: number; removed: number } | undefined {
  const added = details?.added ?? details?.totalAdded ?? details?.diff?.added;
  const removed = details?.removed ?? details?.totalRemoved ?? details?.diff?.removed;
  if (Number.isInteger(added) && added >= 0 && Number.isInteger(removed) && removed >= 0) return { added, removed };
  if (typeof details?.patch !== "string") return;
  let plus = 0, minus = 0, oldRemaining = 0, newRemaining = 0, sawHunk = false;
  for (const line of details.patch.split("\n")) {
    const hunk = line.match(/^@@ -\d+(?:,(\d+))? \+\d+(?:,(\d+))? @@/);
    if (hunk) {
      oldRemaining = hunk[1] === undefined ? 1 : Number(hunk[1]);
      newRemaining = hunk[2] === undefined ? 1 : Number(hunk[2]);
      sawHunk = true;
      continue;
    }
    if (line.startsWith("+") && newRemaining > 0) { plus++; newRemaining--; }
    else if (line.startsWith("-") && oldRemaining > 0) { minus++; oldRemaining--; }
    else if (line.startsWith(" ")) { oldRemaining = Math.max(0, oldRemaining - 1); newRemaining = Math.max(0, newRemaining - 1); }
  }
  return sawHunk ? { added: plus, removed: minus } : undefined;
}

export function devinToolParts(tool: any): Part[] {
  const name = plain(tool.toolName), args = tool.args ?? {};
  const path = filePath(args.path ?? args.file_path ?? args.filePath, tool.cwd);
  const done = tool.result && !tool.isPartial && !tool.result.isError;
  const part = (text: string, tone: Part["tone"] = "text"): Part => ({ text, tone });
  const file = (action: string): Part[] => [part(action + (path ? " " : "")), part(path, "dim")];
  let parts: Part[];
  switch (name) {
    case "bash": case "shell": case "exec_command": {
      const command = String(args.command ?? args.cmd ?? name).replace(/\r\n/g, "\n").trim();
      const lines = command.split("\n");
      return [part(plain(lines[0])), ...(lines.length > 1 ? [part(` (+${lines.length - 1} lines)`, "dim")] : [])];
    }
    case "read": {
      const count = done ? readCount(tool.result) : undefined;
      const offset = Number.isInteger(args.offset) && args.offset > 0 ? args.offset : 1;
      parts = count && (args.offset || args.limit)
        ? [part(`Read lines ${offset}-${offset + count - 1} in `), part(path, "dim")]
        : file("Read");
      if (count !== undefined) parts.push(part(` ${count} lines`, "dim"));
      return parts;
    }
    case "edit": parts = file(done ? "Edited" : "Edit"); break;
    case "write": parts = file(done ? "Wrote" : "Write"); break;
    case "ls": return file("List");
    case "grep": return [part(`${done ? "Searched for" : "Search for"} ${plain(args.pattern)}${path ? " in " : ""}`), part(path, "dim")];
    case "find": return [part(`Find ${plain(args.pattern)}${path ? " in " : ""}`), part(path, "dim")];
    case "apply_patch": {
      const patch = String(args.patchText ?? args.patch_text ?? args.patch ?? "");
      const files = [...patch.matchAll(/^\*\*\* (?:Update|Add|Delete) File: (.+)$/gm)].map((m) => filePath(m[1], tool.cwd));
      parts = [part(`${done ? "Patched" : "Patch"} `), part(files.join(", "), "dim")];
      break;
    }
    default: {
      const detail = args.command ?? args.query ?? args.pattern ?? args.description ?? args.prompt ?? path;
      return [part(`${name}${detail ? ` ${plain(detail)}` : ""}`)];
    }
  }
  const counts = done ? editCounts(tool.result.details) : undefined;
  if (counts) parts.push(part(` +${counts.added}`, "success"), part(` -${counts.removed}`, "error"));
  return parts;
}

export function devinToolSummary(tool: any): string {
  return devinToolParts(tool).map((part) => part.text).join("");
}

export function renderDevinTool(tool: any, width: number, theme: Theme): string[] {
  if (tool.hideComponent) return [];
  const failed = tool.result?.isError === true;
  const complete = Boolean(tool.result) && tool.isPartial !== true;
  const color = failed ? "error" : complete ? "success" : tool.executionStarted ? "accent" : "dim";
  const icon = failed ? "×" : complete ? "✓" : tool.executionStarted ? "…" : "○";
  const body = devinToolParts(tool).map((part) => theme.fg(part.tone === "text" ? "dim" : part.tone, part.text)).join("");
  const lines = [truncateToWidth(` ${theme.fg(color, icon)} ${body}`, width, "…")];
  if (failed) {
    const error = tool.result.content?.filter((block: any) => block.type === "text").map((block: any) => block.text ?? "").join("\n").split(/\r?\n/).find((line: string) => plain(line));
    if (error) lines.push(truncateToWidth(`   ${theme.fg("error", plain(error))}`, width, "…"));
  }
  return lines;
}

/** Read pi-ask's result schema without importing or changing the installed plugin. */
export function renderDevinAskUserDetails(tool: any, width: number, theme: Theme): string[] {
  const result = tool.result;
  if (!result || tool.isPartial === true) return [];
  const details = result.details;
  const rows: { text: unknown; tone: "text" | "muted" | "dim" | "error" | "warning" }[] = [];
  const safe = (value: unknown): string => typeof value === "string"
    ? stripVTControlCharacters(value).replace(/\r\n?/g, "\n").replace(/\t/g, "  ").replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f]/g, "")
    : "";
  const strings = (value: unknown): string[] => Array.isArray(value) ? value.filter((item) => typeof item === "string") : [];
  if (!Array.isArray(details?.questions) || !details.questions.length || result.isError || details.error || details.cancelled || details.mode === "elaborate") {
    // Cancellation, validation errors and elaboration have their own upstream
    // summaries. Preserve them instead of presenting partial answers as final.
    for (const block of result.content ?? []) {
      if (block.type === "text") rows.push({ text: block.text, tone: result.isError || details?.error ? "error" : details?.cancelled || details?.mode === "elaborate" ? "warning" : "muted" });
    }
  } else {
    for (const [index, question] of details.questions.entries()) {
      if (!question || typeof question !== "object") continue;
      const input = tool.args?.questions?.find((item: any) => item?.id === question.id);
      const answer = details.answers?.[question.id];
      rows.push({ text: `问题 ${index + 1}：${safe(question.prompt || input?.prompt || question.label || question.id)}`, tone: "muted" });
      const labels = strings(answer?.labels);
      const custom = safe(answer?.customText);
      const values = strings(answer?.values);
      const selected = labels.length ? [...labels] : values.map((value) => input?.options?.find((option: any) => option.value === value)?.label ?? value);
      if (custom && !selected.includes(custom)) selected.push(custom);
      rows.push({ text: `回答：${selected.length ? selected.join("、") : "未回答"}`, tone: "text" });
      if (safe(answer?.note)) rows.push({ text: `备注：${answer.note}`, tone: "dim" });
      for (const [value, note] of Object.entries(answer?.optionNotes ?? {})) {
        if (!safe(note)) continue;
        const label = input?.options?.find((option: any) => option.value === value)?.label ?? labels[values.indexOf(value)] ?? value;
        rows.push({ text: `选项备注（${label}）：${note}`, tone: "dim" });
      }
    }
  }
  return rows.flatMap((row) => safe(row.text).split("\n").flatMap((line) =>
    wrapTextWithAnsi(line, Math.max(1, width - 3)).map((wrapped) => truncateToWidth(`   ${theme.fg(row.tone, wrapped)}`, width, "…"))));
}

function thinkingRuns(component: any): number[] {
  const runs: number[] = [];
  let inRun = false;
  for (const [index, block] of (component.lastMessage?.content ?? []).entries()) {
    if (block.type !== "thinking") { inRun = false; continue; }
    if (!block.thinking?.trim()) continue;
    if (!inRun) runs.push(index);
    inRun = true;
  }
  return runs;
}

function thinkingVisible(component: any, run: number): boolean {
  const hidden = component.thinkingVisibilityOverrides?.get(run) ?? component.hideThinkingBlock;
  // Ctrl+T and explicit per-block expansion still reveal the complete reasoning.
  return !hidden;
}

function visibleAssistant(component: any): boolean {
  const message = component.lastMessage;
  return Boolean(message?.errorMessage || ["error", "aborted", "length"].includes(message?.stopReason) || message?.content?.some((block: any) =>
    block.type === "text" && block.text?.trim()) || thinkingRuns(component).some((_index, run) => thinkingVisible(component, run)));
}

/** Only the existing bottom working spinner stays visible; never alter reasoning or literal text. */
function prepareThinking(component: any, enabled: () => boolean): void {
  const runs = thinkingRuns(component);
  const layout = enabled() ? runs.map((_index, run) => thinkingVisible(component, run)).join(",") : "native";
  if (component[THINKING_LAYOUT] !== layout) {
    component[THINKING_LAYOUT] = layout;
    delete component[MESSAGE_CACHE];
  }
  let run = 0;
  for (const region of component.contentContainer?.children ?? []) {
    // New Pi wraps thinking in MouseRegion; older versions use direct Text /
    // italic Markdown. Keep expanded reasoning and its mouse handling intact.
    const wrapped = region.constructor?.name === "MouseRegion" ? region.child : undefined;
    const directLabel = region instanceof Text && plain((region as any).text) === plain(component.hiddenThinkingLabel ?? "Thinking...");
    if (!wrapped && !directLabel && !region.defaultTextStyle?.italic) continue;
    const currentRun = run++;
    if (!(wrapped instanceof Text || directLabel) || currentRun >= runs.length) continue;
    if (!region[THINKING_HOOK]) {
      const original = region.render;
      region.render = function (width: number) {
        return this[THINKING_HOOK]() ? original.call(this, width) : [];
      };
    }
    region[THINKING_HOOK] = () => !enabled() || thinkingVisible(component, currentRun);
  }
}

function neighbor(component: any, step: 1 | -1): any {
  const children = component[PARENT]?.children;
  if (!Array.isArray(children)) return;
  const index = children.indexOf(component);
  if (index < 0) return;
  for (let i = index + step; i >= 0 && i < children.length; i += step) {
    const child = children[i];
    if (child instanceof Spacer || child.hideComponent) continue;
    if (child instanceof AssistantMessageComponent && !visibleAssistant(child)) continue;
    return child;
  }
}

function transcript(component: any): boolean {
  return component instanceof ToolExecutionComponent || component instanceof AssistantMessageComponent || component instanceof UserMessageComponent;
}

export function isDevinToolSeparator(spacer: any): boolean {
  return neighbor(spacer, -1) instanceof ToolExecutionComponent && neighbor(spacer, 1) instanceof ToolExecutionComponent;
}

/** Messages own their one-row boundary; only transcript-level spacers are suppressed. */
function isTranscriptSeparator(spacer: any): boolean {
  return transcript(neighbor(spacer, -1)) && transcript(neighbor(spacer, 1));
}

function boundary(component: any, lines: string[]): string[] {
  if (!lines.length) return lines;
  const previous = neighbor(component, -1);
  if (!transcript(previous)) return lines;
  return component instanceof ToolExecutionComponent && previous instanceof ToolExecutionComponent ? lines : ["", ...lines];
}

function trimPadding(lines: string[]): string[] {
  const result = [...lines];
  while (result.length && !stripVTControlCharacters(result[0]!).trim()) result.shift();
  while (result.length && !stripVTControlCharacters(result.at(-1)!).trim()) result.pop();
  return result;
}

export function resetDevinUserMessageTracking(): void {
  userMessageParent = undefined;
}

/** Keyboard fallback for terminals without transcript mouse support. */
export function setDevinUserMessagesExpanded(expanded: boolean): number {
  let count = 0;
  for (const component of userMessageParent?.deref()?.children ?? []) {
    if (!(component instanceof UserMessageComponent) || !(component as any)[USER_FOLD]) continue;
    (component as any)[USER_EXPANDED] = expanded;
    count++;
  }
  return count;
}

function foldUserMessage(component: any, width: number, lines: string[], options: DevinViewOptions): string[] {
  if (component[PARENT]) userMessageParent = new WeakRef(component[PARENT]);
  if (lines.length <= USER_FOLD_THRESHOLD || lines.some((line) => line.includes("\x1b_G") || line.includes("\x1b]1337;File="))) return lines;
  const expanded = component[USER_EXPANDED] === true;
  const body = (expanded ? lines : lines.slice(0, USER_PREVIEW_LINES)).map((line) => line.replace(COPY_ZONES, ""));
  // Truncating a rendered message must not leave an open terminal copy zone.
  // The synthetic control is outside the message's copy zone in either state.
  body[0] = `\x1b]133;A\x07${body[0]}`;
  body[body.length - 1] += "\x1b]133;B\x07\x1b]133;C\x07";
  const label = expanded ? `▾ 收起（共 ${lines.length} 行）` : `▸ 展开剩余 ${lines.length - USER_PREVIEW_LINES} 行（共 ${lines.length} 行）`;
  const theme = options.theme();
  const text = theme.fg("muted", label);
  const fallback = truncateToWidth(`  ${text}`, width, "…");
  const control = options.renderUserControl
    ? options.renderUserControl(text, width)
    : theme.bg("userMessageBg", fallback + " ".repeat(Math.max(0, width - visibleWidth(fallback))));
  component[USER_FOLD] = { width, row: body.length, columns: Math.min(width, 2 + visibleWidth(label)), total: lines.length } satisfies UserFoldLayout;
  return [...body, truncateToWidth(control, width, "…")];
}

/** Remove cc-my-pi's paragraph dot while retaining Markdown, code, styles and width. */
function prepareParagraphs(component: any, enabled: () => boolean): void {
  for (const child of component.contentContainer?.children ?? []) {
    if (child.constructor?.name !== "DottedParagraph") continue;
    if (!child[DOTTED_HOOK]) {
      const original = child.render;
      child.render = function (width: number) {
        if (!this[DOTTED_HOOK]()) return original.call(this, width);
        return original.call(this, width + 2).map((line: string) => truncateToWidth(` ${sliceByColumn(line, 3, Math.max(0, width - 1))}`, width, ""));
      };
    }
    child[DOTTED_HOOK] = enabled;
  }
}

/** Reload-safe dispatchers: later loads replace hooks, not prototype wrappers. */
export function installDevinView(options: DevinViewOptions): void {
  const toolProto = ToolExecutionComponent.prototype as any;
  toolProto[TOOL_HOOK] = (tool: any, width: number, original: () => string[]) => {
    if (!options.enabled()) return original();
    if (tool.hideComponent) return [];
    // Preserve image protocol rendering and its layout; don't silently hide images.
    if (tool.imageComponents?.length) return original();
    if (tool.toolName === "ask_user" && tool.result && tool.isPartial !== true && (tool.expanded || options.askUserDetails?.() !== false)) {
      const theme = options.theme();
      return boundary(tool, [renderDevinTool(tool, width, theme)[0]!, ...renderDevinAskUserDetails(tool, width, theme)]);
    }
    if (!tool.expanded) return boundary(tool, renderDevinTool(tool, width, options.theme()));
    const lines = trimPadding(original());
    const chrome = (line: string) => /^[\s─━═╭╮╰╯┌┐└┘│]*$/.test(stripVTControlCharacters(line));
    while (lines.length && chrome(lines[0]!)) lines.shift();
    while (lines.length && chrome(lines.at(-1)!)) lines.pop();
    if (lines.length) lines.shift(); // Replace the original call header.
    return boundary(tool, [renderDevinTool(tool, width, options.theme())[0]!, ...lines]);
  };
  if (!toolProto[INSTALLED]) {
    const original = toolProto.render;
    toolProto.render = function (width: number) {
      return toolProto[TOOL_HOOK](this, width, () => original.call(this, width));
    };
    toolProto[INSTALLED] = true;
  }

  const assistantProto = AssistantMessageComponent.prototype as any;
  // Neutralize the first version's post-render hook when upgrading a live session.
  assistantProto[OLD_ASSISTANT_HOOK] = (lines: string[]) => lines;
  for (const MessageClass of [AssistantMessageComponent, UserMessageComponent]) {
    const proto = MessageClass.prototype as any;
    proto[MESSAGE_HOOK] = (component: any, _width: number, original: () => string[]) => {
      const enabled = options.enabled();
      if (component instanceof UserMessageComponent) (component as any)[USER_FOLD] = undefined;
      if (component[MESSAGE_MODE] !== enabled) {
        delete component[MESSAGE_CACHE];
        component[MESSAGE_MODE] = enabled;
      }
      if (component instanceof AssistantMessageComponent) {
        prepareParagraphs(component, options.enabled);
        prepareThinking(component, options.enabled);
      }
      if (!enabled) return original();
      let lines = trimPadding(original().filter((line) => !/^✻ Turn took /.test(stripVTControlCharacters(line).trim())));
      if (component instanceof UserMessageComponent) lines = foldUserMessage(component, _width, lines, options);
      const result = boundary(component, lines);
      if (component[USER_FOLD]) component[USER_FOLD].row += result.length - lines.length;
      return result;
    };
    if (!proto[MESSAGE_INSTALLED]) {
      const original = proto.render;
      proto.render = function (width: number) {
        return proto[MESSAGE_HOOK](this, width, () => original.call(this, width));
      };
      proto[MESSAGE_INSTALLED] = true;
    }
  }

  const userProto = UserMessageComponent.prototype as any;
  userProto[USER_MOUSE_HOOK] = (component: any, event: any, original: () => any) => {
    if (!options.enabled()) return original();
    const layout = component[USER_FOLD] as UserFoldLayout | undefined;
    if (!layout) return original();
    if (event.type === "click" && event.button === "left" && !event.shift && !event.alt && !event.ctrl &&
      (event.clickCount ?? 1) === 1 && event.width === layout.width && event.y === layout.row && event.x >= 0 && event.x < layout.columns) {
      component[USER_EXPANDED] = component[USER_EXPANDED] !== true;
      return { handled: true, render: true };
    }
    // Do not capture body clicks, drags or wheel events: native selection and
    // scrolling must keep working despite the cropped Markdown child layout.
    return undefined;
  };
  if (!userProto[USER_MOUSE_INSTALLED]) {
    const original = userProto.handleMouse;
    userProto.handleMouse = function (event: any) {
      return userProto[USER_MOUSE_HOOK](this, event, () => original?.call(this, event));
    };
    userProto[USER_MOUSE_INSTALLED] = true;
  }

  const spacerProto = Spacer.prototype as any;
  spacerProto[SPACER_HOOK] = (spacer: any) => options.enabled() && isTranscriptSeparator(spacer);
  if (!spacerProto[INSTALLED]) {
    const original = spacerProto.render;
    spacerProto.render = function (width: number) {
      return spacerProto[SPACER_HOOK](this) ? [] : original.call(this, width);
    };
    spacerProto[INSTALLED] = true;
  }
}
