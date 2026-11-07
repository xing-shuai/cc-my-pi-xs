/**
 * Statusline: model / context gauge / cost / tok-s segment.
 *
 * Own code (not vendored): moved in from the owner's Pi-config
 * `packages/statusline` (2026-07-20), bundled here as the `statuslineEnabled`
 * module (registered from `extensions/index.ts` behind a reload gate).
 */
import type {
	ExtensionAPI,
	ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import {
	emptyModelInfoState,
	MODEL_INFO_CHANNEL,
	REFRESH_CHANNEL,
} from "../shared/dashboard-state.ts";

import { TurnTelemetryTracker } from "./telemetry.ts";

const LIVE_UPDATE_INTERVAL_MS = 250;

function getSessionCost(ctx: ExtensionContext) {
	let cost = 0;

	for (const entry of ctx.sessionManager.getBranch()) {
		if (entry.type === "message" && entry.message.role === "assistant") {
			cost += entry.message.usage.cost.total;
		}
	}

	return cost;
}

function getLatestCacheHitRate(ctx: ExtensionContext) {
	let latestCacheHitRate: number | null = null;

	for (const entry of ctx.sessionManager.getBranch()) {
		if (entry.type !== "message" || entry.message.role !== "assistant")
			continue;

		const { input, cacheRead, cacheWrite } = entry.message.usage;
		const promptTokens = input + cacheRead + cacheWrite;
		latestCacheHitRate =
			(cacheRead > 0 || cacheWrite > 0) && promptTokens > 0
				? (cacheRead / promptTokens) * 100
				: null;
	}

	return latestCacheHitRate;
}

export default function modelInfo(pi: ExtensionAPI) {
	let state = emptyModelInfoState();
	let telemetry = new TurnTelemetryTracker();
	let rateTimer: ReturnType<typeof setInterval> | undefined;
	let currentContext: ExtensionContext | undefined;

	const publish = () => pi.events.emit(MODEL_INFO_CHANNEL, { ...state });

	function refresh(ctx: ExtensionContext) {
		currentContext = ctx;
		const model = ctx.model;
		const usage = ctx.getContextUsage();
		state = {
			...state,
			provider: model?.provider ?? "",
			modelId: model?.id ?? "no-model",
			modelName: model?.name ?? model?.id ?? "No model",
			thinking: model?.reasoning ? pi.getThinkingLevel() : "off",
			contextTokens: usage?.tokens ?? null,
			contextWindow: usage?.contextWindow ?? model?.contextWindow ?? 0,
			contextPercent: usage?.percent ?? null,
			cost: getSessionCost(ctx),
			latestCacheHitRate: getLatestCacheHitRate(ctx),
		};
		publish();
	}

	function updateLiveRate() {
		if (!state.generating) return;
		const live = telemetry.getLiveTps();
		state = {
			...state,
			tokensPerSecond: live?.tps ?? null,
			speedKind: "live",
			speedStale: live?.stale ?? false,
		};
		publish();
	}

	function stopTimer() {
		if (rateTimer) clearInterval(rateTimer);
		rateTimer = undefined;
	}

	const stopRefreshListener = pi.events.on(REFRESH_CHANNEL, () => {
		if (currentContext) refresh(currentContext);
	});

	pi.on("session_start", (_event, ctx) => {
		stopTimer();
		telemetry = new TurnTelemetryTracker();
		state = emptyModelInfoState();
		refresh(ctx);
	});

	pi.on("model_select", (_event, ctx) => refresh(ctx));
	pi.on("thinking_level_select", (event) => {
		state = { ...state, thinking: event.level };
		publish();
	});

	pi.on("agent_start", (event, ctx) => {
		telemetry.handle(event);
		state = { ...state, tokensPerSecond: null, speedKind: "live", speedStale: false, generating: true };
		stopTimer();
		if (ctx.mode === "tui") {
			rateTimer = setInterval(updateLiveRate, LIVE_UPDATE_INTERVAL_MS);
			rateTimer.unref?.();
		}
		refresh(ctx);
	});

	pi.on("turn_start", (event) => {
		telemetry.handle(event);
		updateLiveRate();
	});
	pi.on("message_start", (event) => {
		telemetry.handle(event);
		if (event.message.role === "assistant") updateLiveRate();
	});
	pi.on("message_update", (event) => {
		// Reading the window on a timer, not just on deltas, makes stalls decay.
		telemetry.handle(event);
	});
	pi.on("message_end", (event, ctx) => {
		telemetry.handle(event);
		if (event.message.role !== "assistant") return;
		updateLiveRate();
		refresh(ctx);
	});
	pi.on("turn_end", (event, ctx) => {
		telemetry.handle(event);
		updateLiveRate();
		refresh(ctx);
	});
	pi.on("agent_end", () => stopTimer());
	pi.on("agent_settled", (event, ctx) => {
		const final = telemetry.handle(event);
		stopTimer();
		state = {
			...state,
			tokensPerSecond: final?.tps ?? null,
			speedKind: "average",
			speedStale: false,
			generating: false,
		};
		refresh(ctx);
	});
	pi.on("session_shutdown", () => {
		stopTimer();
		stopRefreshListener();
		currentContext = undefined;
	});
}
