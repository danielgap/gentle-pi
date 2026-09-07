import {
	existsSync,
	mkdirSync,
	readFileSync,
	renameSync,
	writeFileSync,
} from "node:fs";
import { dirname } from "node:path";
import {
	THINKING_LEVELS,
	normalizeModelConfig,
	normalizeModelId,
	type AgentModelConfig,
	type ThinkingLevel,
} from "./model-routing-authority.ts";

export const MODEL_PROFILES_VERSION = 1 as const;

export interface ModelProfile {
	model: string;
	thinking?: ThinkingLevel;
	agents: AgentModelConfig;
}

export interface ModelProfilesConfig {
	version: typeof MODEL_PROFILES_VERSION;
	active?: string;
	profiles: Record<string, ModelProfile>;
}

export type ModelProfilesFileResult =
	| { status: "missing"; path: string }
	| { status: "invalid"; path: string }
	| { status: "valid"; path: string; config: ModelProfilesConfig };

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

const RESERVED_PROFILE_NAMES = new Set(["__proto__", "constructor", "prototype"]);

function validProfileName(value: string): boolean {
	return value.length > 0
		&& value.length <= 64
		&& !RESERVED_PROFILE_NAMES.has(value)
		&& !/[\u0000-\u001f\u007f]/u.test(value);
}

export function splitModelRef(value: string): { provider: string; model: string } | undefined {
	const normalized = normalizeModelId(value);
	if (!normalized) return undefined;
	const separator = normalized.indexOf("/");
	if (separator <= 0 || separator === normalized.length - 1) return undefined;
	return { provider: normalized.slice(0, separator), model: normalized.slice(separator + 1) };
}

export function parseModelProfiles(value: unknown): ModelProfilesConfig | undefined {
	if (!isRecord(value) || value.version !== MODEL_PROFILES_VERSION || !isRecord(value.profiles)) return undefined;
	const profiles: Record<string, ModelProfile> = {};
	for (const [name, raw] of Object.entries(value.profiles)) {
		if (!validProfileName(name) || !isRecord(raw) || typeof raw.model !== "string") return undefined;
		const model = normalizeModelId(raw.model);
		if (!model || !splitModelRef(model)) return undefined;
		if (raw.thinking !== undefined && (typeof raw.thinking !== "string" || !THINKING_LEVELS.includes(raw.thinking as ThinkingLevel))) return undefined;
		if (!isRecord(raw.agents)) return undefined;
		const normalizedAgents = normalizeModelConfig(raw.agents);
		if (!normalizedAgents || Object.keys(normalizedAgents).length !== Object.keys(raw.agents).length) return undefined;
		const agents: AgentModelConfig = {};
		for (const [agent, entry] of Object.entries(normalizedAgents)) {
			agents[agent] = {
				...(entry.model === undefined ? {} : { model: entry.model }),
				...(entry.thinking === undefined ? {} : { thinking: entry.thinking }),
			};
		}
		profiles[name] = {
			model,
			...(raw.thinking === undefined ? {} : { thinking: raw.thinking as ThinkingLevel }),
			agents,
		};
	}
	if (Object.keys(profiles).length === 0) return undefined;
	const active = value.active;
	if (active !== undefined && (typeof active !== "string" || profiles[active] === undefined)) return undefined;
	return {
		version: MODEL_PROFILES_VERSION,
		...(active === undefined ? {} : { active }),
		profiles,
	};
}

export function readModelProfiles(path: string): ModelProfilesFileResult {
	if (!existsSync(path)) return { status: "missing", path };
	try {
		const config = parseModelProfiles(JSON.parse(readFileSync(path, "utf8")));
		return config ? { status: "valid", path, config } : { status: "invalid", path };
	} catch {
		return { status: "invalid", path };
	}
}

function writeJsonAtomically(path: string, value: unknown): void {
	mkdirSync(dirname(path), { recursive: true });
	const temporary = `${path}.tmp-${process.pid}-${Date.now()}`;
	writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
	renameSync(temporary, path);
}

export function writeModelProfiles(path: string, config: ModelProfilesConfig): void {
	const normalized = parseModelProfiles(config);
	if (!normalized) throw new Error("Invalid model profiles config");
	writeJsonAtomically(path, normalized);
}

export function readPiSettings(settingsPath: string): Record<string, unknown> {
	if (!existsSync(settingsPath)) return {};
	try {
		const value = JSON.parse(readFileSync(settingsPath, "utf8"));
		if (!isRecord(value)) throw new Error("not an object");
		return value;
	} catch (error) {
		throw new Error(`Invalid Pi settings file: ${settingsPath}`, { cause: error });
	}
}

export function routingForProfile(
	target: AgentModelConfig,
	current: AgentModelConfig,
): AgentModelConfig {
	const routing: AgentModelConfig = { ...target };
	for (const name of Object.keys(current)) {
		if (routing[name] === undefined) routing[name] = { model: "inherit" };
	}
	return routing;
}

export function writePiModelDefaults(
	settingsPath: string,
	modelRef: string,
	thinking?: ThinkingLevel,
): void {
	const parsed = splitModelRef(modelRef);
	if (!parsed) throw new Error(`Invalid model reference: ${modelRef}`);
	const settings = readPiSettings(settingsPath);
	settings.defaultProvider = parsed.provider;
	settings.defaultModel = parsed.model;
	if (thinking !== undefined) settings.defaultThinkingLevel = thinking;
	writeJsonAtomically(settingsPath, settings);
}
