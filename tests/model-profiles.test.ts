import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { createGentleAiExtension } from "../extensions/gentle-ai.ts";
import {
	parseModelProfiles,
	readModelProfiles,
	routingForProfile,
	writePiModelDefaults,
} from "../lib/model-profiles.ts";

const VALID = {
	version: 1,
	active: "zai",
	profiles: {
		zai: {
			model: "zai/glm-5.3",
			thinking: "medium",
			agents: { "sdd-apply": { model: "zai/glm-5.3" } },
		},
		openai: {
			model: "openai-codex/gpt-5.6-sol",
			thinking: "high",
			agents: { "sdd-apply": { model: "openai-codex/gpt-5.6-terra", thinking: "high" } },
		},
	},
};

test("parseModelProfiles accepts a versioned named profile file", () => {
	assert.deepEqual(parseModelProfiles(VALID), VALID);
});

test("parseModelProfiles rejects invalid profiles as one unit", () => {
	assert.equal(parseModelProfiles({ ...VALID, version: 2 }), undefined);
	assert.equal(parseModelProfiles({ version: 1, profiles: { broken: { model: "missing-slash", agents: {} } } }), undefined);
	assert.equal(parseModelProfiles({ version: 1, active: "missing", profiles: VALID.profiles }), undefined);
	assert.equal(parseModelProfiles({ version: 1, profiles: { broken: { model: "zai/glm-5.3", thinking: "extreme", agents: {} } } }), undefined);
	assert.equal(parseModelProfiles(JSON.parse('{"version":1,"profiles":{"__proto__":{"model":"zai/glm-5.3","agents":{}}}}')), undefined);
	assert.equal(parseModelProfiles({ version: 1, profiles: { broken: { model: "zai/glm-5.3", agents: { "unsafe name": { model: "zai/glm-5.3" } } } } }), undefined);
});

test("readModelProfiles distinguishes missing, invalid, and valid files", () => {
	const root = mkdtempSync(join(tmpdir(), "gentle-pi-model-profiles-"));
	const path = join(root, "model-profiles.json");
	assert.deepEqual(readModelProfiles(path), { status: "missing", path });
	writeFileSync(path, "{");
	assert.deepEqual(readModelProfiles(path), { status: "invalid", path });
	writeFileSync(path, `${JSON.stringify(VALID)}\n`);
	assert.deepEqual(readModelProfiles(path), { status: "valid", path, config: VALID });
});

test("writePiModelDefaults preserves unrelated settings", () => {
	const root = mkdtempSync(join(tmpdir(), "gentle-pi-model-defaults-"));
	const path = join(root, "settings.json");
	writeFileSync(path, `${JSON.stringify({ theme: "dark", packages: ["gentle-pi"] })}\n`);
	writePiModelDefaults(path, "openai-codex/gpt-5.6-sol", "high");
	assert.deepEqual(JSON.parse(readFileSync(path, "utf8")), {
		theme: "dark",
		packages: ["gentle-pi"],
		defaultProvider: "openai-codex",
		defaultModel: "gpt-5.6-sol",
		defaultThinkingLevel: "high",
	});
});

test("routingForProfile explicitly inherits routes missing from the target", () => {
	assert.deepEqual(
		routingForProfile(
			{ "sdd-apply": { model: "openai-codex/gpt-5.6-terra", thinking: "high" } },
			{ "sdd-apply": { model: "zai/glm-5.3" }, "gentle-ai-worker": { model: "zai/glm-5.3" } },
		),
		{
			"sdd-apply": { model: "openai-codex/gpt-5.6-terra", thinking: "high" },
			"gentle-ai-worker": { model: "inherit" },
		},
	);
});

test("writePiModelDefaults keeps the existing default effort when a profile omits it", () => {
	const root = mkdtempSync(join(tmpdir(), "gentle-pi-model-default-effort-"));
	const path = join(root, "settings.json");
	writeFileSync(path, `${JSON.stringify({ defaultThinkingLevel: "low" })}\n`);
	writePiModelDefaults(path, "openai-codex/gpt-5.6-sol");
	assert.equal(JSON.parse(readFileSync(path, "utf8")).defaultThinkingLevel, "low");
});

test("writePiModelDefaults refuses invalid existing settings without overwriting", () => {
	const root = mkdtempSync(join(tmpdir(), "gentle-pi-model-defaults-invalid-"));
	const path = join(root, "settings.json");
	writeFileSync(path, "[]\n");
	assert.throws(() => writePiModelDefaults(path, "openai-codex/gpt-5.6-sol", "medium"), /invalid/i);
	assert.equal(readFileSync(path, "utf8"), "[]\n");
});

test("gentle:profile activates the main model and replaces persisted routing", async () => {
	const root = mkdtempSync(join(tmpdir(), "gentle-pi-profile-activation-"));
	const configHome = join(root, "gentle-ai");
	const agentHome = join(root, "agent");
	mkdirSync(configHome, { recursive: true });
	mkdirSync(agentHome, { recursive: true });
	const profiles = {
		version: 1,
		active: "zai",
		profiles: {
			zai: { model: "zai/glm-5.3", thinking: "medium", agents: {} },
			openai: {
				model: "openai-codex/gpt-5.6-sol",
				thinking: "high",
				agents: { "gentle-ai-worker": { model: "openai-codex/gpt-5.6-terra", thinking: "high" } },
			},
		},
	};
	writeFileSync(join(configHome, "model-profiles.json"), `${JSON.stringify(profiles)}\n`);
	writeFileSync(join(configHome, "models.json"), `${JSON.stringify({ stale: { model: "zai/glm-5.3" } })}\n`);
	writeFileSync(join(agentHome, "settings.json"), `${JSON.stringify({ theme: "dark" })}\n`);

	const previousConfigHome = process.env.GENTLE_PI_CONFIG_HOME;
	const previousAgentHome = process.env.GENTLE_PI_AGENT_HOME;
	process.env.GENTLE_PI_CONFIG_HOME = configHome;
	process.env.GENTLE_PI_AGENT_HOME = agentHome;
	try {
		const commands = new Map<string, { handler(args: string, ctx: ExtensionContext): Promise<void> }>();
		const selectedModels: unknown[] = [];
		const thinkingLevels: string[] = [];
		const model = { provider: "openai-codex", id: "gpt-5.6-sol" };
		createGentleAiExtension({ nativeReviewCli: null })({
			on() {},
			registerTool() {},
			registerCommand(name: string, definition: { handler(args: string, ctx: ExtensionContext): Promise<void> }) {
				commands.set(name, definition);
			},
			async setModel(value: unknown) {
				selectedModels.push(value);
				return true;
			},
			setThinkingLevel(value: string) {
				thinkingLevels.push(value);
			},
		} as unknown as ExtensionAPI);
		const command = commands.get("gentle:profile");
		assert.ok(command);
		await command.handler("openai", {
			cwd: root,
			modelRegistry: { find: () => model },
			ui: { notify() {}, select: async () => undefined },
		} as unknown as ExtensionContext);

		assert.deepEqual(selectedModels, [model]);
		assert.deepEqual(thinkingLevels, ["high"]);
		assert.deepEqual(JSON.parse(readFileSync(join(agentHome, "settings.json"), "utf8")), {
			theme: "dark",
			defaultProvider: "openai-codex",
			defaultModel: "gpt-5.6-sol",
			defaultThinkingLevel: "high",
		});
		assert.deepEqual(JSON.parse(readFileSync(join(configHome, "models.json"), "utf8")), {
			"gentle-ai-worker": { model: "openai-codex/gpt-5.6-terra", thinking: "high" },
			stale: { model: "inherit" },
		});
		assert.equal(JSON.parse(readFileSync(join(configHome, "model-profiles.json"), "utf8")).active, "openai");
	} finally {
		if (previousConfigHome === undefined) delete process.env.GENTLE_PI_CONFIG_HOME;
		else process.env.GENTLE_PI_CONFIG_HOME = previousConfigHome;
		if (previousAgentHome === undefined) delete process.env.GENTLE_PI_AGENT_HOME;
		else process.env.GENTLE_PI_AGENT_HOME = previousAgentHome;
	}
});
