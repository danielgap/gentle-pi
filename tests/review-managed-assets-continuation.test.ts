import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { __testing } from "../extensions/gentle-ai.ts";
import { NativeReviewIntegrationError, type NativeReviewCli } from "../lib/native-review-cli.ts";
import { CandidateViewRegistry } from "../lib/review-candidate-view.ts";
import type { ReviewFailureV2, ReviewStatusV3 } from "../lib/review-integration-v2.ts";

// gentle-pi#627: gentle-ai reports a stale managed-asset set as a typed
// next_transition.kind "stop" (reason_code managed_assets_outdated) whose
// additive `continuation` names the runnable sync remediation, and START's
// preflight failure envelope carries the same continuation. The decoder level
// is pinned in tests/review-integration-v2.test.ts; these tests pin the FACADE
// surfacing: the operator must be told to run the sync command instead of
// staring at a bare stop.

const SHA = `sha256:${"a".repeat(64)}`;

function repository(t: test.TestContext): string {
	const cwd = mkdtempSync(join(tmpdir(), "gentle-pi-managed-assets-"));
	t.after(() => rmSync(cwd, { recursive: true, force: true }));
	execFileSync("git", ["init", "-b", "main"], { cwd });
	writeFileSync(join(cwd, "app.ts"), "export const value = 1;\n");
	execFileSync("git", ["add", "."], { cwd });
	execFileSync("git", ["-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "-m", "base"], { cwd });
	return cwd;
}

function staleManagedAssetsStatus(): ReviewStatusV3 {
	return {
		contract: "gentle-ai.review-integration/v2",
		applicability: "current_target",
		authority: { version: "compact-v2", lineageId: "review-managed-assets", state: "reviewer_results_required", generation: 1, revision: SHA },
		action: "stop",
		replayability: "not_replayable",
		targetIdentity: SHA,
		projection: {
			schema: "gentle-ai.review-integration.projection/v1",
			kind: "current-changes",
			projection: "workspace",
			baseTree: "3".repeat(40),
			initialReviewTree: "4".repeat(40),
			currentCandidateTree: "4".repeat(40),
			pathsDigest: SHA,
			paths: ["app.ts"],
			intendedUntracked: [],
			intendedUntrackedProof: SHA,
			initialSnapshotIdentity: SHA,
			currentSnapshotIdentity: SHA,
		},
		candidates: [],
		nextTransition: {
			kind: "stop",
			reasonCode: "managed_assets_outdated",
			continuation: { operation: "sync", command: "gentle-ai sync --agent pi", agent: "pi", staleAssets: ["agents/sdd-implement.md"] },
		},
		raw: { schema: "gentle-ai.review-integration.status/v6", action: "stop" },
	} as unknown as ReviewStatusV3;
}

test("STATUS surfaces the managed-assets stop continuation as the sync remediation (#627)", async (t) => {
	const cwd = repository(t);
	const native = { targetStatus: async () => staleManagedAssetsStatus() } as unknown as NativeReviewCli;
	const result = await __testing.executeReviewControllerOperation(
		{ operation: "status" },
		cwd,
		native,
		undefined,
		new CandidateViewRegistry(),
	) as Record<string, unknown>;
	assert.equal(result.status, "blocked");
	assert.equal(result.stop_reason_code, "managed_assets_outdated");
	assert.equal(result.sync_command, "gentle-ai sync --agent pi");
	assert.equal(result.sync_agent, "pi");
	assert.deepEqual(result.stale_assets, ["agents/sdd-implement.md"]);
	assert.match(String(result.next_action), /gentle-ai sync --agent pi/);
	assert.match(String(result.next_action), /gentle_review \{"operation":"inspect"\}/);
});

test("a START preflight managed-assets failure surfaces the sync command beside the native failure (#627)", () => {
	const failure = {
		schema: "gentle-ai.review-integration.failure/v2",
		contract: "gentle-ai.review-integration/v2",
		operation: "review.start",
		phase: "preflight",
		code: "managed_assets_outdated",
		message: "Managed reviewer assets are outdated; synchronize them before starting review.",
		mutationOutcome: "not_started",
		authorityApplicability: "not_evaluated",
		retrySafe: true,
		replayability: "manual_action_required",
		requiredInputs: [],
		nextAction: "stop",
		continuation: { operation: "sync", command: "gentle-ai sync --agent pi", agent: "pi", staleAssets: ["agents/jd-judge-a.md"] },
		raw: {},
	} as unknown as ReviewFailureV2;
	const surfaced = __testing.nativeOperationFailure("start", new NativeReviewIntegrationError(failure)) as Record<string, unknown>;
	assert.equal(surfaced.status, "blocked");
	assert.ok("native_failure" in surfaced, "the native error envelope must remain available to the caller");
	assert.equal(surfaced.sync_command, "gentle-ai sync --agent pi");
	assert.equal(surfaced.sync_agent, "pi");
	assert.match(String(surfaced.next_action), /gentle-ai sync --agent pi/);
	assert.match(String(surfaced.next_action), /gentle_review \{"operation":"inspect"\}/);

	// failures without a continuation keep the envelope's own next action
	const plain = { ...failure, continuation: undefined } as unknown as ReviewFailureV2;
	const plainSurfaced = __testing.nativeOperationFailure("start", new NativeReviewIntegrationError(plain)) as Record<string, unknown>;
	assert.equal(plainSurfaced.sync_command, undefined);
	assert.equal(plainSurfaced.next_action, "stop");
});
