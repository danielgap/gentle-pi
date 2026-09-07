import assert from "node:assert/strict";
import test from "node:test";
import { visibleWidth } from "@earendil-works/pi-tui";
import {
	accountIdFromToken,
	formatReset,
	parseAnthropicHeaders,
	parseCodexHeaders,
	parseUsageHeaders,
	parseCodexUsage,
	parseZaiUsage,
	providerNote,
	renderUsageBar,
	renderUsagePanel,
	SUPPORTED_USAGE_PROVIDERS,
	isUsageProvider,
	UsageStore,
	windowLabel,
	ZAI_GLM_PROVIDER,
	ZAI_PROVIDER,
	ZAI_USAGE_PROVIDERS,
	type ProviderUsage,
} from "../lib/shell-usage.ts";
import { fetchZaiUsage } from "../extensions/gentle-shell.ts";

// Subscription usage: what each connected provider says about its windows.
// Parsers are pure; the store only remembers the latest snapshot.

const NOW = 1_788_600_000_000;

const plainTheme = {
	fg(_color: string, text: string) {
		return text;
	},
};

const taggedTheme = {
	fg(color: string, text: string) {
		return `<${color}>${text}</${color}>`;
	},
};

const CODEX_PAYLOAD = {
	plan_type: "pro",
	rate_limit: {
		allowed: true,
		limit_reached: false,
		primary_window: { used_percent: 40, limit_window_seconds: 604_800, reset_after_seconds: 175_331, reset_at: 1_788_777_491 },
		secondary_window: null,
	},
	additional_rate_limits: [
		{
			limit_name: "codex_spark",
			metered_feature: "spark",
			rate_limit: {
				allowed: true,
				limit_reached: false,
				primary_window: { used_percent: 12, limit_window_seconds: 18_000, reset_after_seconds: 18_000, reset_at: 1_788_620_161 },
				secondary_window: { used_percent: 3, limit_window_seconds: 604_800, reset_after_seconds: 604_800, reset_at: 1_789_206_961 },
			},
		},
	],
	credits: { has_credits: false, unlimited: false, balance: "0" },
	email: "someone@example.com",
};

test("windowLabel names the common windows and falls back to hours or days", () => {
	assert.equal(windowLabel(18_000), "5h");
	assert.equal(windowLabel(604_800), "week");
	assert.equal(windowLabel(10_800), "3h");
	assert.equal(windowLabel(172_800), "2d");
	assert.equal(windowLabel(1_800), "30m");
});

test("formatReset speaks in minutes, hours, or days", () => {
	assert.equal(formatReset(NOW + 25 * 60_000, NOW), "resets in 25m");
	assert.equal(formatReset(NOW + (1 * 3600 + 48 * 60) * 1000, NOW), "resets in 1h 48m");
	assert.equal(formatReset(NOW + (2 * 86_400 + 5 * 3600) * 1000, NOW), "resets in 2d 5h");
	assert.equal(formatReset(NOW - 1000, NOW), "resets now");
	assert.equal(formatReset(null, NOW), "");
});

test("parseCodexUsage keeps plan, windows, and named limits, and never keeps the email", () => {
	const usage = parseCodexUsage(CODEX_PAYLOAD, NOW);
	assert.equal(usage.provider, "openai-codex");
	assert.equal(usage.plan, "pro");
	assert.equal(usage.fetchedAt, NOW);
	assert.deepEqual(
		usage.limits.map((limit) => ({ name: limit.name, windows: limit.windows.map((w) => `${w.label}:${w.usedPercent}`) })),
		[
			{ name: "codex", windows: ["week:40"] },
			{ name: "codex_spark", windows: ["5h:12", "week:3"] },
		],
	);
	assert.equal(usage.limits[0].windows[0].resetAt, 1_788_777_491_000);
	assert.equal(JSON.stringify(usage).includes("example.com"), false);
});

test("parseCodexUsage tolerates a payload without rate limits", () => {
	const usage = parseCodexUsage({ plan_type: "free" }, NOW);
	assert.equal(usage.plan, "free");
	assert.deepEqual(usage.limits, []);
});

test("parseCodexHeaders reads the SSE rate-limit headers when a provider sends them", () => {
	const usage = parseCodexHeaders(
		{
			"x-codex-primary-used-percent": "62",
			"x-codex-primary-window-minutes": "300",
			"x-codex-primary-reset-at": "1788620161",
			"x-codex-secondary-used-percent": "31",
			"x-codex-secondary-window-minutes": "10080",
			"x-codex-secondary-reset-at": "1789206961",
			"content-type": "text/event-stream",
		},
		NOW,
	);
	assert.ok(usage);
	assert.deepEqual(usage.limits[0].windows.map((w) => `${w.label}:${w.usedPercent}:${w.resetAt}`), ["5h:62:1788620161000", "week:31:1789206961000"]);
	assert.equal(parseCodexHeaders({ "content-type": "text/event-stream" }, NOW), undefined);
});

test("accountIdFromToken decodes the chatgpt account claim from an OAuth JWT", () => {
	const claims = Buffer.from(JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "acct-123" } })).toString("base64url");
	assert.equal(accountIdFromToken(`header.${claims}.sig`), "acct-123");
	assert.equal(accountIdFromToken("sk-not-a-jwt"), undefined);
	assert.equal(accountIdFromToken("a.!!!.c"), undefined);
});

test("renderUsageBar summarizes the main limit with a gauge and the rest as percentages", () => {
	const usage = parseCodexUsage(CODEX_PAYLOAD, NOW);
	assert.equal(renderUsageBar(usage, plainTheme), "codex week ▰▰▰▱▱▱▱▱ 40%");
	const twoWindows = parseCodexUsage({ ...CODEX_PAYLOAD, rate_limit: CODEX_PAYLOAD.additional_rate_limits[0].rate_limit }, NOW);
	assert.equal(renderUsageBar(twoWindows, plainTheme), "codex 5h ▰▱▱▱▱▱▱▱ 12% · week 3%");
	const hot = renderUsageBar(parseCodexUsage({ rate_limit: { primary_window: { used_percent: 91, limit_window_seconds: 18_000, reset_at: 1 } } }, NOW), taggedTheme);
	assert.match(hot, /<warning>▰▰▰▰▰▰▰<\/warning>/);
	assert.equal(renderUsageBar(parseCodexUsage({}, NOW), plainTheme), undefined);
});

test("renderUsagePanel lists each provider with meters, resets, and a stale marker", () => {
	const usage = parseCodexUsage(CODEX_PAYLOAD, NOW);
	const lines = renderUsagePanel([usage], plainTheme, 70, NOW + 3 * 60_000);
	for (const line of lines) assert.ok(visibleWidth(line) <= 70, `too wide: ${line}`);
	assert.match(lines[0], /^openai-codex · pro · updated 3m ago$/);
	assert.match(lines[1], /^ {2}codex$/);
	assert.match(lines[2], /^ {4}week +▰+▱+ +40% +resets in 2d 1h$/);
	assert.match(lines[3], /^ {2}codex_spark$/);
	assert.match(lines[4], /^ {4}5h /);
	assert.match(lines[5], /^ {4}week /);
	assert.deepEqual(renderUsagePanel([], plainTheme, 120, NOW), ["No subscription usage yet. Usage arrives with the next response, or press r to fetch it."]);
});

test("renderUsagePanel puts the active provider first and explains missing data", () => {
	const codex = parseCodexUsage(CODEX_PAYLOAD, NOW);
	const claude = parseAnthropicHeaders({ "anthropic-ratelimit-unified-5h-utilization": "0.2" }, NOW);
	assert.ok(claude);
	const both = renderUsagePanel([codex, claude], plainTheme, 100, NOW, { provider: "anthropic" });
	assert.match(both[0], /^✿ anthropic · updated just now$/);
	assert.match(both[1], /^ {2}claude$/);
	assert.match(both.find((line) => line.startsWith("openai-codex")) ?? "", /^openai-codex · pro/);

	const apiKey = renderUsagePanel([codex], plainTheme, 100, NOW, { provider: "openai" });
	assert.match(apiKey[0], /^✿ openai · no subscription usage for this provider$/);
	assert.match(apiKey[1], /^openai-codex · pro/);

	const pending = renderUsagePanel([], plainTheme, 100, NOW, { provider: "anthropic" });
	assert.deepEqual(pending, ["✿ anthropic · usage arrives with the first response"]);
	assert.deepEqual(renderUsagePanel([], plainTheme, 100, NOW, { provider: "openai-codex" }), ["✿ openai-codex · no usage yet · r to fetch"]);
});

test("UsageStore keeps the latest snapshot per provider and lists them in order", () => {
	const store = new UsageStore();
	const first: ProviderUsage = { provider: "openai-codex", plan: "pro", limits: [], fetchedAt: 1 };
	const second: ProviderUsage = { provider: "openai-codex", plan: "pro", limits: [], fetchedAt: 2 };
	store.record(first);
	store.record({ provider: "anthropic", plan: undefined, limits: [], fetchedAt: 1 });
	store.record(second);
	assert.equal(store.get("openai-codex"), second);
	assert.deepEqual(store.all().map((usage) => usage.provider), ["openai-codex", "anthropic"]);
});

test("parseAnthropicHeaders turns the unified utilization fractions into 5h and weekly windows", () => {
	const headers = {
		"anthropic-ratelimit-unified-status": "allowed_warning",
		"anthropic-ratelimit-unified-5h-utilization": "0.42",
		"anthropic-ratelimit-unified-5h-reset": "1788620161",
		"anthropic-ratelimit-unified-7d-utilization": "0.875",
		"anthropic-ratelimit-unified-7d-reset": "1789206961",
		"anthropic-ratelimit-unified-representative-claim": "seven_day",
	};
	const usage = parseAnthropicHeaders(headers, NOW);
	assert.ok(usage);
	assert.equal(usage.provider, "anthropic");
	assert.deepEqual(usage.limits.map((limit) => limit.name), ["claude"]);
	assert.deepEqual(usage.limits[0].windows.map((w) => `${w.label}:${w.usedPercent}:${w.resetAt}`), ["5h:42:1788620161000", "week:87.5:1789206961000"]);
	assert.equal(usage.limits[0].limitReached, false);
	assert.equal(parseAnthropicHeaders({ ...headers, "anthropic-ratelimit-unified-status": "rejected" }, NOW)?.limits[0].limitReached, true);
	assert.equal(parseAnthropicHeaders({ "anthropic-ratelimit-requests-remaining": "99" }, NOW), undefined);
});

const ZAI_PAYLOAD = {
	code: 200,
	msg: "Operation successful",
	data: {
		limits: [
			{ type: "TIME_LIMIT", unit: 5, number: 1, usage: 4000, currentValue: 0, remaining: 4000, percentage: 0, nextResetTime: 1789651429999, usageDetails: [{ modelCode: "search-prime", usage: 0 }] },
			{ type: "TOKENS_LIMIT", unit: 3, number: 5, percentage: 5, nextResetTime: 1788824370973 },
			{ type: "TOKENS_LIMIT", unit: 6, number: 1, percentage: 6, nextResetTime: 1789392229980 },
		],
		level: "max",
	},
	success: true,
};

test("parseZaiUsage keeps the plan and the two token windows, and drops the search counter", () => {
	const usage = parseZaiUsage(ZAI_GLM_PROVIDER, ZAI_PAYLOAD, NOW);
	assert.equal(usage.provider, "zai-glm");
	assert.equal(usage.plan, "max");
	assert.equal(usage.fetchedAt, NOW);
	assert.deepEqual(usage.limits.map((limit) => ({ name: limit.name, limitReached: limit.limitReached, windows: limit.windows.map((w) => `${w.label}:${w.usedPercent}:${w.windowSeconds}:${w.resetAt}`) })), [
		{ name: "zai", limitReached: false, windows: ["5h:5:18000:1788824370973", "week:6:604800:1789392229980"] },
	]);
});

test("parseZaiUsage accepts CREDIT_LIMIT windows and degrades to empty limits without throwing", () => {
	const credit = parseZaiUsage(ZAI_PROVIDER, { data: { limits: [{ type: "CREDIT_LIMIT", unit: 3, percentage: 41, nextResetTime: 1788824370973 }], level: "lite" } }, NOW);
	assert.deepEqual(credit.limits[0].windows.map((w) => `${w.label}:${w.usedPercent}`), ["5h:41"]);
	assert.equal(credit.plan, "lite");

	const missingReset = parseZaiUsage(ZAI_PROVIDER, { data: { limits: [{ type: "TOKENS_LIMIT", unit: 6, percentage: 3 }] } }, NOW);
	assert.deepEqual(missingReset.limits[0].windows.map((w) => w.resetAt), [null]);

	const unusable = parseZaiUsage(ZAI_PROVIDER, { data: { limits: [{ type: "TOKENS_LIMIT", unit: 3, percentage: "5" }, { type: "TOKENS_LIMIT", unit: 9, percentage: 7 }, { type: "MYSTERY_LIMIT", unit: 6, percentage: 7 }, null] } }, NOW);
	assert.deepEqual(unusable.limits, []);
	assert.equal(unusable.plan, undefined);

	assert.deepEqual(parseZaiUsage(ZAI_PROVIDER, null, NOW).limits, []);
	assert.deepEqual(parseZaiUsage(ZAI_PROVIDER, undefined, NOW).limits, []);
});

test("the zai providers are registered as supported with the fetch note", () => {
	assert.deepEqual(ZAI_USAGE_PROVIDERS, ["zai", "zai-glm"]);
	for (const provider of ZAI_USAGE_PROVIDERS) {
		assert.ok(SUPPORTED_USAGE_PROVIDERS.includes(provider));
		assert.equal(providerNote(provider), "no usage yet · r to fetch");
	}
});

function fakeZaiFetch(payload: unknown = ZAI_PAYLOAD, ok = true) {
	const calls: Array<{ url: string; headers: Record<string, string> }> = [];
	const fetchFn = (async (url: string | URL, init?: RequestInit) => {
		calls.push({ url: String(url), headers: (init?.headers ?? {}) as Record<string, string> });
		return { ok, json: async () => payload } as Response;
	}) as typeof fetch;
	return { fetchFn, calls };
}

test("fetchZaiUsage sends the bearer key and parses the quota payload", async () => {
	const { fetchFn, calls } = fakeZaiFetch();
	const usage = await fetchZaiUsage(ZAI_GLM_PROVIDER, "zai-key", fetchFn, NOW);
	assert.equal(usage?.provider, "zai-glm");
	assert.equal(usage?.plan, "max");
	assert.equal(calls[0].url, "https://api.z.ai/api/monitor/usage/quota/limit");
	assert.equal(calls[0].headers.Authorization, "Bearer zai-key");

	const silent = fakeZaiFetch();
	assert.equal(await fetchZaiUsage(ZAI_PROVIDER, undefined, silent.fetchFn, NOW), undefined);
	assert.equal(silent.calls.length, 0, "without a key nothing must be sent anywhere");
	assert.equal(await fetchZaiUsage(ZAI_PROVIDER, "zai-key", fakeZaiFetch({}, false).fetchFn, NOW), undefined);
});

    test("parseUsageHeaders picks whichever provider the headers belong to", () => {
    	assert.equal(parseUsageHeaders({ "x-codex-primary-used-percent": "10", "x-codex-primary-window-minutes": "300" }, NOW)?.provider, "openai-codex");
    	assert.equal(parseUsageHeaders({ "anthropic-ratelimit-unified-5h-utilization": "0.1" }, NOW)?.provider, "anthropic");
    	assert.equal(parseUsageHeaders({ "content-type": "application/json" }, NOW), undefined);
    });
    
    test("parseZaiUsage clamps percentages into 0-100 and marks the limit reached at 100", () => {
    	const payload = {
    		data: {
    			limits: [
    				{ type: "TOKENS_LIMIT", unit: 3, percentage: 137, nextResetTime: 1788824370973 },
    				{ type: "TOKENS_LIMIT", unit: 6, percentage: -7, nextResetTime: 1789392229980 },
    			],
    			level: "max",
    		},
    	};
    	const usage = parseZaiUsage(ZAI_PROVIDER, payload, NOW);
    	const windows = usage.limits[0]?.windows ?? [];
    	assert.equal(windows[0]?.usedPercent, 100, "an over-range percentage is clamped down to 100");
    	assert.equal(windows[1]?.usedPercent, 0, "a negative percentage is clamped up to 0");
    	assert.equal(usage.limits[0]?.limitReached, true, "a window at 100 means the limit is reached");
    });
    
    test("parseZaiUsage skips windows whose percentage is not a finite number", () => {
    	const payload = {
    		data: {
    			limits: [
    				{ type: "TOKENS_LIMIT", unit: 3, percentage: Number.NaN, nextResetTime: 1788824370973 },
    				{ type: "TOKENS_LIMIT", unit: 6, percentage: 42, nextResetTime: 1789392229980 },
    			],
    		},
    	};
    	const usage = parseZaiUsage(ZAI_PROVIDER, payload, NOW);
    	const windows = usage.limits[0]?.windows ?? [];
    	assert.equal(windows.length, 1, "only the finite-percentage window survives");
    	assert.equal(windows[0]?.usedPercent, 42);
    	assert.equal(usage.limits[0]?.limitReached, false);
    });
    
    test("fetchZaiUsage returns undefined when the request itself fails", async () => {
    	const fetchFn = (async () => {
    		throw new Error("network down");
    	}) as typeof fetch;
    	assert.equal(await fetchZaiUsage(ZAI_PROVIDER, "zai-key", fetchFn, NOW), undefined);
    });
    
    test("isUsageProvider accepts exactly codex and the z.ai providers", () => {
    	assert.equal(isUsageProvider("openai-codex"), true);
    	assert.equal(isUsageProvider("zai"), true);
    	assert.equal(isUsageProvider("zai-glm"), true);
    	assert.equal(isUsageProvider("anthropic"), false, "anthropic usage arrives via headers, not a fetch");
    	assert.equal(isUsageProvider("ollama"), false);
    });
