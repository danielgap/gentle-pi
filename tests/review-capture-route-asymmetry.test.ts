import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import { __testing } from "../extensions/gentle-ai.ts";
import { CandidateViewRegistry } from "../lib/review-candidate-view.ts";
import type { NativeReviewCli } from "../lib/native-review-cli.ts";
import type { ReviewCollectInputV3, ReviewStatusV3 } from "../lib/review-integration-v2.ts";

// Discriminator for gentle-ai#4491: a collect binding retained while STATUS
// flows through one resolved workspace root must be rejected as "belongs to a
// different session route" when the capture resolves a DIFFERENT root of the
// SAME repository (a linked worktree sharing the Git common dir), on the
// FIRST capture with zero admissions. The matching-root control capture must
// pass the route check and reach the native capture verb. This is the
// root-asymmetry mechanism mapped in the #4491 thread: retention keys the
// route on the root the STATUS flowed through, while the capture compares
// against resolveReviewControllerWorkspaceRoot's resolution, and both roots
// are valid worktrees of one repository so nothing else fails first.

const SHA = `sha256:${"a".repeat(64)}`;
const TREE = "b".repeat(40);

function correctionPlanInput(lineageId: string): ReviewCollectInputV3 {
	const arguments_ = [{ name: "lineage", value: lineageId, token: `--lineage=${lineageId}` }, { name: "target", value: SHA, token: `--target=${SHA}` }];
	return { name: "correction_plan", schema: "https://gentle-ai.dev/schema/review/correction-plan/v1", captureOperation: "review.capture-correction-plan", arguments: arguments_, submission: { operationToken: "capture-correction-plan", argumentTokens: [`--lineage=${lineageId}`, "--correction-lines={{value}}"], values: [{ slot: "correction_lines", domain: "integer", substitutionLocation: 1, minimum: 1, maximum: 200 }] } } as unknown as ReviewCollectInputV3;
}

function status(lineageId: string, inputs: readonly ReviewCollectInputV3[]): ReviewStatusV3 {
	return {
		contract: "gentle-ai.review-integration/v2",
		applicability: "current_target",
		authority: { version: "compact-v2", lineageId, state: "correction_required", generation: 1, revision: SHA },
		receipt: { status: "expected_missing" },
		action: "stop",
		replayability: "not_replayable",
		targetIdentity: SHA,
		projection: {
			schema: "gentle-ai.review-candidate-projection/v1",
			kind: "current-changes",
			projection: "workspace",
			baseTree: TREE,
			initialReviewTree: TREE,
			currentCandidateTree: TREE,
			pathsDigest: SHA,
			paths: ["app.ts"],
			intendedUntracked: [],
			intendedUntrackedProof: SHA,
			initialSnapshotIdentity: SHA,
			currentSnapshotIdentity: SHA,
		},
		repair: { schema: "gentle-ai.review-authority-repair-assessment/v1", status: "unsupported", counts: { lineages: 0, compactLineages: 0, legacyLineages: 0, events: 0, bytes: 0, eligibleCandidates: 0, unsupportedLineages: 0, conflicts: 0 }, supportedOperations: ["review/complete-fix", "review/validate-fix"], authorizationSchema: "gentle-ai.review-repair-authorization/v1" },
		candidates: [],
		nextTransition: { kind: "collect", reasonCode: "capture_required", collect: { inputs } },
		raw: { schema: "gentle-ai.review-integration.status/v5" },
	} as unknown as ReviewStatusV3;
}

function bindingOf(result: Record<string, unknown>): string {
	return (result.collectBindings as readonly { collectBinding: string }[])[0]!.collectBinding;
}

function mainRepositoryWithLinkedWorktree(t: test.TestContext): { main: string; linked: string } {
	const root = realpathSync(mkdtempSync(join(tmpdir(), "gentle-pi-route-asymmetry-")));
	t.after(() => {
		try { execFileSync("git", ["-C", root, "worktree", "remove", "--force", join(root, "linked")], { stdio: "ignore" }); } catch {}
		try { chmodSync(root, 0o700); } catch {}
		rmSync(root, { recursive: true, force: true });
	});
	const git = (...arguments_: string[]) => execFileSync("git", arguments_, { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
	git("init", "-b", "main");
	writeFileSync(join(root, "tracked.txt"), "base\n");
	git("add", "tracked.txt");
	git("-c", "user.name=Route Asymmetry Test", "-c", "user.email=route@example.invalid", "commit", "-m", "base");
	writeFileSync(join(root, "tracked.txt"), "candidate\n");
	git("add", "tracked.txt");
	git("-c", "user.name=Route Asymmetry Test", "-c", "user.email=route@example.invalid", "commit", "-m", "candidate");
	git("worktree", "add", "--detach", join(root, "linked"), "HEAD");
	return { main: realpathSync(root), linked: realpathSync(join(root, "linked")) };
}

test("first capture rejects as different session route when the workspace root differs from the retained route", async (t) => {
	const { main, linked } = mainRepositoryWithLinkedWorktree(t);
	assert.notEqual(main, linked, "fixture must produce two distinct resolved roots");
	const candidateViews = new CandidateViewRegistry();
	t.after(() => candidateViews.cleanupAll());
	const lineageId = "route-asymmetry-4491";
	const selections = new Map();
	const requests: Array<Record<string, unknown>> = [];
	let captures = 0;
	const native = {
		targetStatus: async (request: Record<string, unknown>) => {
			requests.push(request);
			return status(lineageId, [correctionPlanInput(lineageId)]);
		},
		captureCorrectionPlan: async () => {
			captures += 1;
			return { schema: "gentle-ai.review-last-event-closure/v1", operation: "review.capture-correction-plan", lineageId, state: "correction_required", storeRevision: SHA };
		},
	} as unknown as NativeReviewCli;

	// Retention: STATUS flows through the MAIN worktree, registering the
	// binding's route under that resolved root.
	const listed = await __testing.executeReviewControllerOperation({ operation: "status", lineageId }, main, native, undefined, candidateViews, undefined, selections);

	// Divergent arm: the capture resolves the LINKED worktree of the same
	// repository. Zero admissions have happened; this is the first capture.
	const rejected = await __testing.executeReviewCaptureOperation({ lineageId, collectBinding: bindingOf(listed as Record<string, unknown>), correctionLines: 1 }, linked, native, undefined, candidateViews, selections, true);

	// Control arm: identical capture resolving the MAIN worktree, the same
	// root the STATUS retained under.
	const captured = await __testing.executeReviewCaptureOperation({ lineageId, collectBinding: bindingOf(listed as Record<string, unknown>), correctionLines: 1 }, main, native, undefined, candidateViews, selections, true);

	assert.equal(rejected.outcome, "capture-binding-rejected");
	assert.match(String(rejected.reason), /different session route/);
	assert.equal((rejected as { mutation_performed?: boolean }).mutation_performed, false);
	assert.notEqual(captured.outcome, "capture-binding-rejected");
	assert.equal(captured.outcome, "native-last-event-closure");
	assert.equal(captures, 1);
});
