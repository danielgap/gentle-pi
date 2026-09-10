import assert from "node:assert/strict";
import { spawn as nodeSpawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { AGENT_MODE, type AgentDefinition } from "../lib/agents-config.ts";
import { AgentRunner, type ChildLike, type RunnerDeps, type TaskRequest } from "../lib/agents-runner.ts";
import { TASK_STATUS, TaskStore } from "../lib/agents-protocol.ts";

const fixture = fileURLToPath(new URL("./fixtures/agents-process-child.mjs", import.meta.url));
const agent: AgentDefinition = { name: "process", description: "test", filePath: "/test.md", scope: "global", instructions: "", model: undefined, thinking: undefined, mode: undefined, tools: [] };
const request = (prompt: string): TaskRequest => ({ agent, prompt, label: undefined, context: undefined, mode: AGENT_MODE.BACKGROUND, cwd: process.cwd(), parentSessionId: "test", model: undefined, thinking: undefined, sessionDir: "/tmp", resumeSessionPath: undefined, env: {} });

const waitFor = async (predicate: () => boolean, timeoutMs = 10_000): Promise<void> => {
	const deadline = Date.now() + timeoutMs;
	while (!predicate()) {
		if (Date.now() >= deadline) throw new Error(`condition was not met within ${timeoutMs}ms`);
		await new Promise((resolve) => setTimeout(resolve, 10));
	}
};

test("POSIX cleanup retains queue slots when a leader exits but its TERM-resisting descendant remains", { skip: process.platform === "win32" }, async () => {
	const store = new TaskStore();
	let launches = 0;
	let firstPid: number | undefined;
	const descendantPids: Array<number | undefined> = [];
	let firstDetached = false;
	const ownedPids: number[] = [];
	const runtimeTimers: Array<{ fn: () => void; timer: ReturnType<typeof setTimeout> | undefined; cancelled: boolean }> = [];
	const armRuntimeTimeout = (index: number) => {
		const timer = runtimeTimers[index];
		if (timer && !timer.cancelled && timer.timer === undefined) timer.timer = setTimeout(timer.fn, 500);
	};
	const deps: RunnerDeps = {
		spawn: (_command, _args, options): ChildLike => {
			launches += 1;
			const env = launches === 1 ? { ...options.env, AGENTS_PROCESS_CHILD_EXIT_ON_TERM: "1" } : launches === 3 ? { ...options.env, AGENTS_PROCESS_CHILD_EXIT_AFTER_READY: "1" } : options.env;
			const child = nodeSpawn(process.execPath, [fixture], { cwd: options.cwd, env, detached: options.detached, stdio: ["pipe", "pipe", "pipe"] });
			const launchIndex = launches - 1;
			ownedPids.push(child.pid!);
			if (launches === 1) {
				firstPid = child.pid;
				firstDetached = options.detached === true;
			}
			let output = "";
			child.stdout.on("data", (chunk: Buffer) => {
				output += chunk.toString();
				const match = output.match(/DESCENDANT:(\d+)/);
				if (match) {
					descendantPids[launchIndex] = Number(match[1]);
					armRuntimeTimeout(launchIndex);
				}
			});
			return child;
		},
		now: Date.now,
		schedule: (fn, ms) => {
			if (ms === 500) {
				const timer = { fn, timer: undefined, cancelled: false };
				const index = launches - 1;
				runtimeTimers[index] = timer;
				if (descendantPids[index] !== undefined) armRuntimeTimeout(index);
				return () => {
					timer.cancelled = true;
					if (timer.timer) clearTimeout(timer.timer);
				};
			}
			const timer = setTimeout(fn, ms);
			return () => clearTimeout(timer);
		},
		pi: { command: process.execPath, args: [fixture] },
	};
	const runner = new AgentRunner(store, { maxConcurrency: 1, stallTimeoutMs: 500 }, deps, { askUser: async () => ({ cancelled: true }) });
	const first = runner.run(request("first"));
	const second = runner.run(request("second"));
	const third = runner.run(request("third"));
	const fourth = runner.run(request("fourth"));
	try {
		await waitFor(() => launches === 1 && descendantPids[0] !== undefined);
		assert.equal(firstDetached, true, "the first child owns a POSIX process group");
		assert.equal(runner.cancel(first.id), true);
		assert.equal(store.get(first.id)?.status, TASK_STATUS.RUNNING, "leader exit does not release its live descendant group");
		await new Promise((resolve) => setTimeout(resolve, 40));
		assert.doesNotThrow(() => process.kill(descendantPids[0]!, 0), "the exact TERM-resisting descendant remains alive");
		assert.equal(launches, 1, "the queued task cannot use the slot during SIGTERM grace");
		await waitFor(() => store.get(first.id)?.status === TASK_STATUS.CANCELLED);
		assert.equal(launches, 2, "the slot opens only after the owned group exits");
		assert.throws(() => process.kill(-firstPid!, 0), { code: "ESRCH" }, "SIGKILL cleaned the owned child group, including its descendant");
		await waitFor(() => store.get(second.id)?.status === TASK_STATUS.TIMED_OUT);
		assert.throws(() => process.kill(-ownedPids[1], 0), { code: "ESRCH" }, "timeout also bounds cleanup of its owned group");
		await waitFor(() => launches === 3 && descendantPids[2] !== undefined);
		await new Promise((resolve) => setTimeout(resolve, 40));
		assert.doesNotThrow(() => process.kill(descendantPids[2]!, 0), "the natural-exit descendant remains alive");
		assert.equal(launches, 3, "natural leader exit does not release the queue slot");
		await waitFor(() => store.get(third.id)?.status === TASK_STATUS.FAILED);
		assert.equal(launches, 4, "the queue resumes after natural-exit group cleanup");
		assert.throws(() => process.kill(-ownedPids[2], 0), { code: "ESRCH" }, "natural exit also cleans its owned group");
	} finally {
		if (firstDetached) {
			for (const pid of ownedPids) {
				try { process.kill(-pid, "SIGKILL"); } catch {}
			}
		} else {
			for (const pid of [firstPid, ...descendantPids, ...ownedPids]) {
				if (pid) try { process.kill(pid, "SIGKILL"); } catch {}
			}
		}
		runner.cancel(second.id);
		runner.cancel(third.id);
		runner.cancel(fourth.id);
	}
});

test("startup failures include only a bounded stderr tail", { skip: process.platform === "win32" }, async () => {
	const store = new TaskStore();
	const deps: RunnerDeps = {
		spawn: (_command, _args, options) =>
			nodeSpawn(process.execPath, ["-e", "process.stderr.write('UNIQUE-PREFIX-' + 'z'.repeat(6000) + 'TAIL-MARKER'); process.exit(17);"], { cwd: options.cwd, env: options.env, detached: options.detached, stdio: ["pipe", "pipe", "pipe"] }),
		now: Date.now,
		schedule: (fn, ms) => { const timer = setTimeout(fn, ms); return () => clearTimeout(timer); },
		pi: { command: process.execPath, args: [] },
	};
	const runner = new AgentRunner(store, { maxConcurrency: 1, stallTimeoutMs: 5_000 }, deps, { askUser: async () => ({ cancelled: true }) });
	const task = runner.run(request("stderr-bomb"));
	await waitFor(() => store.get(task.id)?.status === TASK_STATUS.FAILED);
	const error = store.get(task.id)?.error ?? "";
	assert.ok(error.includes("startup diagnostic"), error);
	assert.ok(error.includes("TAIL-MARKER"));
	assert.ok(!error.includes("UNIQUE-PREFIX"), "the discarded stderr prefix must not survive");
	assert.ok(error.length < 4_096 + 256, "the retained diagnostic must stay bounded");
});

test("children that complete RPC startup never report a startup stderr diagnostic", { skip: process.platform === "win32" }, async () => {
	const store = new TaskStore();
	const childScript = "process.stderr.write('RPC-ERA NOISE'); process.stdin.setEncoding('utf8'); process.stdin.on('data', (chunk) => { for (const line of chunk.split('\\n')) { if (!line) continue; try { const command = JSON.parse(line); process.stdout.write(JSON.stringify({ type: 'response', id: command.id, success: true }) + '\\n'); } catch {} } }); setTimeout(() => process.exit(17), 50);";
	const deps: RunnerDeps = {
		spawn: (_command, _args, options) =>
			nodeSpawn(process.execPath, ["-e", childScript], { cwd: options.cwd, env: options.env, detached: options.detached, stdio: ["pipe", "pipe", "pipe"] }),
		now: Date.now,
		schedule: (fn, ms) => { const timer = setTimeout(fn, ms); return () => clearTimeout(timer); },
		pi: { command: process.execPath, args: [] },
	};
	const runner = new AgentRunner(store, { maxConcurrency: 1, stallTimeoutMs: 5_000 }, deps, { askUser: async () => ({ cancelled: true }) });
	const task = runner.run(request("rpc-then-exit"));
	await waitFor(() => store.get(task.id)?.status === TASK_STATUS.FAILED);
	const error = store.get(task.id)?.error ?? "";
	assert.ok(!error.includes("startup diagnostic"), error);
	assert.ok(error.includes("pi exited with code 17"));
});
