package repository

import (
	"context"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"sync"
	"testing"
	"time"

	execution "convenewire.dev/contracts/generated/go/execution"
	wire "convenewire.dev/contracts/generated/go/runtime"
)

func taskGrantFixture(t *testing.T, format string) (*fixture, *BindingStore, TaskGrantSpec, execution.GovernedExecutionManifest) {
	t.Helper()
	f, store, bind := bindingFixture(t, format)
	binding, err := store.Bind(context.Background(), bind, bindingNow)
	if err != nil {
		t.Fatal(err)
	}
	m := resumeWireFixture(t)
	m.Scope.DeviceID = store.owner.DeviceID
	m.Repository.BindingID, m.Repository.RepositoryID, m.Repository.BaseCommit = bind.BindingID, bind.RepositoryID, f.base
	m.Inputs = []execution.GovernedExecutionManifestInput{}
	m.Workspace.IssuedAt = bindingTime(bindingNow)
	m.Workspace.ExpiresAt = bindingTime(bindingNow.Add(30 * time.Minute))
	m.Deadline = m.Workspace.ExpiresAt
	m.ScopePolicy = execution.GovernedExecutionManifestScopePolicy{Access: execution.IsolatedWrite,
		AllowedPaths: []string{"src", "tests"}, ForbiddenPaths: []string{"src/private"}}
	spec := TaskGrantSpec{GrantID: m.Grant.GrantID, BindingID: bind.BindingID, BindingRevision: 1,
		SourceFingerprint: binding.SourceFingerprint, RepositoryID: bind.RepositoryID, BaseCommit: f.base,
		PlanID: m.Scope.PlanID, PlanRevision: m.Scope.PlanRevision, PlanDigest: m.Scope.PlanDigest, NodeKey: m.Scope.NodeKey,
		RoomID: m.Scope.RoomID, TaskID: m.Scope.TaskID, DefinitionRevision: m.Scope.DefinitionRevision,
		CriteriaRevision: m.Scope.CriteriaRevision, AgentID: m.Scope.AgentID, ExpiresAt: bindingTime(bindingNow.Add(time.Hour)),
		Operations:           []execution.KindElement{execution.Prepare, execution.Capture, execution.Verify},
		RuntimeProfile:       execution.ExecutionGrantSummaryRuntimeProfile{ProfileID: m.Repository.RuntimeProfileID, Revision: 1, Digest: m.Repository.RuntimeProfileDigest},
		VerificationProfiles: []execution.ExecutionGrantSummaryVerificationProfile{}, ScopePolicy: execution.ExecutionGrantSummaryScopePolicy(m.ScopePolicy),
		IntegrationTargets: []execution.ExecutionGrantSummaryIntegrationTarget{}}
	for _, p := range m.VerificationProfiles {
		spec.VerificationProfiles = append(spec.VerificationProfiles, execution.ExecutionGrantSummaryVerificationProfile{ProfileID: p.ProfileID, Revision: p.Revision, Digest: p.Digest})
	}
	return f, store, spec, m
}

func issuedTaskManifest(t *testing.T, store *BindingStore, spec TaskGrantSpec, m execution.GovernedExecutionManifest) (TaskGrantView, execution.GovernedExecutionManifest) {
	t.Helper()
	view, err := store.IssueTaskGrant(context.Background(), spec, bindingNow)
	if err != nil {
		t.Fatal(err)
	}
	m.Grant = execution.GovernedExecutionManifestGrant(view.Summary.Grant)
	m.Repository.GrantID, m.Repository.GrantRevision = m.Grant.GrantID, m.Grant.Revision
	resignManifest(t, &m)
	return view, m
}

func integrationGrantOperation(t *testing.T, store *BindingStore, spec TaskGrantSpec,
	m execution.GovernedExecutionManifest) (TaskGrantView, execution.RepositoryOperationRequest) {
	t.Helper()
	spec.Operations = []execution.KindElement{execution.Integrate}
	spec.VerificationProfiles = []execution.ExecutionGrantSummaryVerificationProfile{}
	spec.IntegrationTargets = []execution.ExecutionGrantSummaryIntegrationTarget{{
		RepositoryID: spec.RepositoryID, TargetRef: "refs/heads/release", ExpectedCommit: spec.BaseCommit,
	}}
	view, err := store.IssueTaskGrant(context.Background(), spec, bindingNow)
	if err != nil {
		t.Fatal(err)
	}
	scope := execution.RepositoryOperationRequestExecution(m.Scope)
	operation := execution.RepositoryOperationRequest{Version: 1, OperationID: "op_integration_local0001",
		Plan: execution.RepositoryOperationRequestPlan{PlanID: scope.PlanID, Revision: scope.PlanRevision,
			Digest: scope.PlanDigest, ApprovalOperationID: scope.ApprovalOperationID,
			RoomID: scope.RoomID, RootTaskID: "task_integration_root0001"},
		Execution: &scope, RepositoryID: spec.RepositoryID, BindingID: spec.BindingID,
		DeviceID: scope.DeviceID, Grant: execution.RepositoryOperationRequestGrant(view.Summary.Grant),
		ExpectedGeneration: m.Workspace.WorkspaceGeneration, Deadline: m.Deadline,
		Action: execution.ActionClass{Kind: execution.Integrate, Integrate: &execution.IntegrateClass{
			CandidateCommit: strings.Repeat("b", 40), CandidateTree: strings.Repeat("c", 40),
			InputDigest: strings.Repeat("d", 64), Target: execution.IntegrateTarget(spec.IntegrationTargets[0]),
			IntegrationApprovalOperationID: "op_integration_approval0001",
			VerificationIDS:                []string{"verification_local0001"},
		}},
	}
	operation.RequestDigest = resumeDigest(t, operation, "requestDigest")
	return view, operation
}

func TestTaskGrantIssuanceIsCanonicalDurableAndPathFree(t *testing.T) {
	for _, format := range []string{"sha1", "sha256"} {
		t.Run(format, func(t *testing.T) {
			f, store, spec, m := taskGrantFixture(t, format)
			originalSpec, _ := json.Marshal(spec)
			view, m := issuedTaskManifest(t, store, spec, m)
			afterSpec, _ := json.Marshal(spec)
			if string(originalSpec) != string(afterSpec) {
				t.Fatal("issuance mutated caller-owned slices")
			}
			raw, _ := json.Marshal(view.Summary)
			if wire.ValidateExecutionCommand("executionGrant", raw) != nil || strings.Contains(string(raw), f.root) {
				t.Fatal("invalid or path-bearing wire summary")
			}
			stored, err := os.ReadFile(store.grantPath(spec.GrantID, false))
			if err != nil {
				t.Fatal(err)
			}
			digest, err := wire.ExecutionDigest(stored)
			if err != nil || digest != view.Summary.Grant.Digest {
				t.Fatal("issuance digest is not canonical")
			}
			if err := store.CheckTaskGrant(context.Background(), m, execution.Prepare, bindingNow); err != nil {
				t.Fatal(err)
			}
			if err := store.Close(); err != nil {
				t.Fatal(err)
			}
			reopened, err := OpenBindingStore(context.Background(), store.dataRoot, store.owner, f.executable, Limits{})
			if err != nil {
				t.Fatal(err)
			}
			defer reopened.Close()
			replay, err := reopened.IssueTaskGrant(context.Background(), spec, bindingNow.Add(time.Minute))
			if err != nil || !reflect.DeepEqual(view, replay) {
				t.Fatalf("replay=%+v error=%v", replay, err)
			}
			after, _ := os.ReadFile(reopened.grantPath(spec.GrantID, false))
			if string(after) != string(stored) {
				t.Fatal("retry rewrote consent")
			}
			if err := reopened.CheckTaskGrant(context.Background(), m, execution.Capture, bindingNow.Add(time.Minute)); err != nil {
				t.Fatal(err)
			}
			if f.git(t, f.sourcePath, "rev-parse", "HEAD") != f.base {
				t.Fatal("grant mutated Git")
			}
		})
	}
}

func TestTaskGrantRejectsManifestDriftAndPrivilegeExpansion(t *testing.T) {
	_, store, spec, m := taskGrantFixture(t, "sha1")
	_, m = issuedTaskManifest(t, store, spec, m)
	for name, change := range map[string]func(*execution.GovernedExecutionManifest){
		"grant digest":   func(v *execution.GovernedExecutionManifest) { v.Grant.Digest = strings.Repeat("e", 64) },
		"grant revision": func(v *execution.GovernedExecutionManifest) { v.Grant.Revision++ },
		"grant expiry": func(v *execution.GovernedExecutionManifest) {
			v.Grant.ExpiresAt = bindingTime(bindingNow.Add(2 * time.Hour))
		},
		"repository grant": func(v *execution.GovernedExecutionManifest) { v.Repository.GrantID = "grant_foreign0001" },
		"repository":       func(v *execution.GovernedExecutionManifest) { v.Repository.RepositoryID = "repo_foreign0001" },
		"binding":          func(v *execution.GovernedExecutionManifest) { v.Repository.BindingID = "repobind_foreign0001" },
		"base":             func(v *execution.GovernedExecutionManifest) { v.Repository.BaseCommit = strings.Repeat("a", 40) },
		"device":           func(v *execution.GovernedExecutionManifest) { v.Scope.DeviceID = "device_foreign0001" },
		"agent":            func(v *execution.GovernedExecutionManifest) { v.Scope.AgentID = "agent_foreign0001" },
		"room":             func(v *execution.GovernedExecutionManifest) { v.Scope.RoomID = "room_foreign0001" },
		"task":             func(v *execution.GovernedExecutionManifest) { v.Scope.TaskID = "task_foreign0001" },
		"definition":       func(v *execution.GovernedExecutionManifest) { v.Scope.DefinitionRevision++ },
		"criteria":         func(v *execution.GovernedExecutionManifest) { v.Scope.CriteriaRevision++ },
		"plan":             func(v *execution.GovernedExecutionManifest) { v.Scope.PlanID = "plan_foreign0001" },
		"plan revision":    func(v *execution.GovernedExecutionManifest) { v.Scope.PlanRevision++ },
		"plan digest":      func(v *execution.GovernedExecutionManifest) { v.Scope.PlanDigest = strings.Repeat("f", 64) },
		"node":             func(v *execution.GovernedExecutionManifest) { v.Scope.NodeKey = "other-node" },
		"runtime": func(v *execution.GovernedExecutionManifest) {
			v.Repository.RuntimeProfileDigest = strings.Repeat("e", 64)
		},
		"allowed paths":    func(v *execution.GovernedExecutionManifest) { v.ScopePolicy.AllowedPaths = []string{"."} },
		"prefix collision": func(v *execution.GovernedExecutionManifest) { v.ScopePolicy.AllowedPaths = []string{"src2"} },
		"forbidden paths":  func(v *execution.GovernedExecutionManifest) { v.ScopePolicy.ForbiddenPaths = []string{} },
		"traversal":        func(v *execution.GovernedExecutionManifest) { v.ScopePolicy.AllowedPaths = []string{"src/../private"} },
		"verifier": func(v *execution.GovernedExecutionManifest) {
			v.VerificationProfiles = append(v.VerificationProfiles, execution.GovernedExecutionManifestVerificationProfile{ProfileID: "profile_foreign0001", Revision: 1, Digest: strings.Repeat("e", 64), Required: true})
		},
		"deadline": func(v *execution.GovernedExecutionManifest) { v.Deadline = bindingTime(bindingNow.Add(2 * time.Hour)) },
	} {
		t.Run(name, func(t *testing.T) {
			var changed execution.GovernedExecutionManifest
			raw, _ := json.Marshal(m)
			_ = json.Unmarshal(raw, &changed)
			change(&changed)
			resignManifest(t, &changed)
			if err := store.CheckTaskGrant(context.Background(), changed, execution.Prepare, bindingNow); err == nil {
				t.Fatal("unauthorized manifest accepted")
			}
		})
	}
	for _, op := range []execution.KindElement{execution.Integrate, execution.Publish, execution.Observe, "unknown"} {
		if err := store.CheckTaskGrant(context.Background(), m, op, bindingNow); !errors.Is(err, ErrGrantDenied) {
			t.Fatalf("operation=%s error=%v", op, err)
		}
	}
	corrupt := m
	corrupt.ManifestDigest = strings.Repeat("0", 64)
	if err := store.CheckTaskGrant(context.Background(), corrupt, execution.Prepare, bindingNow); !errors.Is(err, ErrInvalid) {
		t.Fatal(err)
	}
	for _, when := range []time.Time{bindingNow.Add(-time.Nanosecond), bindingNow.Add(time.Hour), bindingNow.Add(30 * time.Minute)} {
		if err := store.CheckTaskGrant(context.Background(), m, execution.Prepare, when); !errors.Is(err, ErrGrantExpired) {
			t.Fatal(err)
		}
	}
	narrower := m
	narrower.ScopePolicy.AllowedPaths = []string{"tests/unit"}
	narrower.ScopePolicy.ForbiddenPaths = []string{}
	resignManifest(t, &narrower)
	if err := store.CheckTaskGrant(context.Background(), narrower, execution.Prepare, bindingNow); err != nil {
		t.Fatal(err)
	}
}

func TestIntegrationGrantAdmitsOnlyExactIndependentTargetOperation(t *testing.T) {
	_, store, spec, manifest := taskGrantFixture(t, "sha1")
	view, operation := integrationGrantOperation(t, store, spec, manifest)
	if err := store.CheckIntegrationGrant(context.Background(), operation, bindingNow.Add(time.Minute)); err != nil {
		t.Fatal(err)
	}
	for name, change := range map[string]func(*execution.RepositoryOperationRequest){
		"action": func(v *execution.RepositoryOperationRequest) { v.Action.Kind = execution.Verify },
		"target": func(v *execution.RepositoryOperationRequest) { v.Action.Integrate.Target.TargetRef = "refs/heads/main" },
		"expected": func(v *execution.RepositoryOperationRequest) {
			v.Action.Integrate.Target.ExpectedCommit = strings.Repeat("a", 40)
		},
		"repository": func(v *execution.RepositoryOperationRequest) { v.RepositoryID = "repo_foreign0001" },
		"binding":    func(v *execution.RepositoryOperationRequest) { v.BindingID = "repobind_foreign0001" },
		"device":     func(v *execution.RepositoryOperationRequest) { v.DeviceID = "device_foreign0001" },
		"agent":      func(v *execution.RepositoryOperationRequest) { v.Execution.AgentID = "agent_foreign0001" },
		"plan":       func(v *execution.RepositoryOperationRequest) { v.Plan.Digest = strings.Repeat("f", 64) },
		"node":       func(v *execution.RepositoryOperationRequest) { v.Execution.NodeKey = "foreign-node" },
		"grant":      func(v *execution.RepositoryOperationRequest) { v.Grant.Digest = strings.Repeat("0", 64) },
	} {
		t.Run(name, func(t *testing.T) {
			var changed execution.RepositoryOperationRequest
			raw, _ := json.Marshal(operation)
			_ = json.Unmarshal(raw, &changed)
			change(&changed)
			changed.RequestDigest = resumeDigest(t, changed, "requestDigest")
			if err := store.CheckIntegrationGrant(context.Background(), changed, bindingNow.Add(time.Minute)); err == nil {
				t.Fatal("changed integration operation retained authority")
			}
		})
	}
	if _, err := store.RevokeTaskGrant(spec.GrantID, 1, view.Summary.Grant.Digest, bindingNow.Add(2*time.Minute)); err != nil {
		t.Fatal(err)
	}
	if err := store.CheckIntegrationGrant(context.Background(), operation, bindingNow.Add(3*time.Minute)); !errors.Is(err, ErrGrantRevoked) {
		t.Fatal(err)
	}
}

func TestIntegrationGrantRejectsMixedRuntimeAuthority(t *testing.T) {
	_, store, spec, manifest := taskGrantFixture(t, "sha1")
	spec.IntegrationTargets = []execution.ExecutionGrantSummaryIntegrationTarget{{
		RepositoryID: spec.RepositoryID, TargetRef: "refs/heads/release", ExpectedCommit: spec.BaseCommit,
	}}
	view, manifest := issuedTaskManifest(t, store, spec, manifest)
	operation := operationForManifest(t, manifest, "op_integration_mixed0001")
	operation.Action = execution.ActionClass{Kind: execution.Integrate, Integrate: &execution.IntegrateClass{
		CandidateCommit: strings.Repeat("b", 40), CandidateTree: strings.Repeat("c", 40),
		InputDigest: strings.Repeat("d", 64), Target: execution.IntegrateTarget(spec.IntegrationTargets[0]),
		IntegrationApprovalOperationID: "op_integration_approval0002", VerificationIDS: []string{"verification_local0002"},
	}}
	operation.Grant = execution.RepositoryOperationRequestGrant(view.Summary.Grant)
	operation.RequestDigest = resumeDigest(t, operation, "requestDigest")
	if err := store.CheckIntegrationGrant(context.Background(), operation, bindingNow.Add(time.Minute)); !errors.Is(err, ErrGrantDenied) {
		t.Fatal(err)
	}
}

func TestTaskGrantRevocationIsRetainedAndDoesNotNeedSourceOrGit(t *testing.T) {
	f, store, spec, m := taskGrantFixture(t, "sha1")
	view, m := issuedTaskManifest(t, store, spec, m)
	if _, err := store.RevokeTaskGrant(spec.GrantID, 1, strings.Repeat("0", 64), bindingNow); !errors.Is(err, ErrConflict) {
		t.Fatal(err)
	}
	if _, err := store.RevokeTaskGrant(spec.GrantID, 2, view.Summary.Grant.Digest, bindingNow); !errors.Is(err, ErrConflict) {
		t.Fatal(err)
	}
	if err := store.Close(); err != nil {
		t.Fatal(err)
	}
	if err := os.Rename(f.sourcePath, f.sourcePath+"-retained"); err != nil {
		t.Fatal(err)
	}
	reopened, err := OpenBindingStore(context.Background(), store.dataRoot, store.owner, "", Limits{})
	if err != nil {
		t.Fatal(err)
	}
	defer reopened.Close()
	revoked, err := reopened.RevokeTaskGrant(spec.GrantID, 1, view.Summary.Grant.Digest, bindingNow.Add(2*time.Hour))
	if err != nil || revoked.Summary.Grant.Revision != 2 || revoked.Summary.RevokedAt == nil {
		t.Fatalf("%+v %v", revoked, err)
	}
	replay, err := reopened.RevokeTaskGrant(spec.GrantID, 1, view.Summary.Grant.Digest, bindingNow.Add(3*time.Hour))
	if err != nil || !reflect.DeepEqual(revoked, replay) {
		t.Fatal("revocation retry changed receipt", err)
	}
	if _, err := reopened.IssueTaskGrant(context.Background(), spec, bindingNow); !errors.Is(err, ErrGrantRevoked) {
		t.Fatal(err)
	}
	if err := reopened.CheckTaskGrant(context.Background(), m, execution.Prepare, bindingNow); !errors.Is(err, ErrGrantRevoked) {
		t.Fatal(err)
	}
	listed, err := reopened.ListTaskGrants()
	if err != nil || len(listed) != 1 || listed[0].Summary.RevokedAt == nil {
		t.Fatal(err)
	}
}

func TestTaskGrantRejectsBindingRevocationAndReplacement(t *testing.T) {
	for _, mode := range []string{"revoked", "replaced"} {
		t.Run(mode, func(t *testing.T) {
			f, store, spec, m := taskGrantFixture(t, "sha1")
			_, m = issuedTaskManifest(t, store, spec, m)
			if mode == "revoked" {
				if _, err := store.Revoke(spec.BindingID, 1, bindingNow); err != nil {
					t.Fatal(err)
				}
			} else {
				if err := os.Rename(f.sourcePath, f.sourcePath+"-retained"); err != nil {
					t.Fatal(err)
				}
				if err := os.Mkdir(f.sourcePath, 0o700); err != nil {
					t.Fatal(err)
				}
			}
			if err := store.CheckTaskGrant(context.Background(), m, execution.Prepare, bindingNow); err == nil {
				t.Fatal("unavailable binding retained authority")
			}
			if _, err := store.IssueTaskGrant(context.Background(), spec, bindingNow); err == nil {
				t.Fatal("retry bypassed binding revalidation")
			}
		})
	}
}

func TestTaskGrantRejectsInvalidOwnerSpecifications(t *testing.T) {
	_, store, spec, _ := taskGrantFixture(t, "sha1")
	for name, change := range map[string]func(*TaskGrantSpec){
		"source pin":          func(v *TaskGrantSpec) { v.SourceFingerprint = strings.Repeat("0", 64) },
		"binding revision":    func(v *TaskGrantSpec) { v.BindingRevision = 2 },
		"expired":             func(v *TaskGrantSpec) { v.ExpiresAt = bindingTime(bindingNow) },
		"unsafe revision":     func(v *TaskGrantSpec) { v.PlanRevision = 9007199254740992 },
		"task traversal":      func(v *TaskGrantSpec) { v.TaskID = "../task_private0001" },
		"null profiles":       func(v *TaskGrantSpec) { v.VerificationProfiles = nil },
		"null allowed":        func(v *TaskGrantSpec) { v.ScopePolicy.AllowedPaths = nil },
		"null forbidden":      func(v *TaskGrantSpec) { v.ScopePolicy.ForbiddenPaths = nil },
		"duplicate operation": func(v *TaskGrantSpec) { v.Operations = append(v.Operations, v.Operations[0]) },
		"unsafe path":         func(v *TaskGrantSpec) { v.ScopePolicy.AllowedPaths = []string{".git/config"} },
		"wrong object format": func(v *TaskGrantSpec) { v.BaseCommit = strings.Repeat("a", 64) },
		"unsafe target": func(v *TaskGrantSpec) {
			v.IntegrationTargets = []execution.ExecutionGrantSummaryIntegrationTarget{{RepositoryID: v.RepositoryID, TargetRef: "refs/heads/a/../main", ExpectedCommit: v.BaseCommit}}
		},
		"foreign target": func(v *TaskGrantSpec) {
			v.IntegrationTargets = []execution.ExecutionGrantSummaryIntegrationTarget{{RepositoryID: "repo_foreign0001", TargetRef: "refs/heads/main", ExpectedCommit: v.BaseCommit}}
		},
	} {
		t.Run(name, func(t *testing.T) {
			var changed TaskGrantSpec
			raw, _ := json.Marshal(spec)
			_ = json.Unmarshal(raw, &changed)
			change(&changed)
			if _, err := store.IssueTaskGrant(context.Background(), changed, bindingNow); err == nil {
				t.Fatal("invalid specification accepted")
			}
		})
	}
	listed, err := store.ListTaskGrants()
	if err != nil || len(listed) != 0 {
		t.Fatalf("invalid issuance persisted: %v %v", listed, err)
	}
}

func TestTaskGrantBoundsCompleteOwnerRecordBeforeMutation(t *testing.T) {
	_, store, spec, _ := taskGrantFixture(t, "sha1")
	found := false
	for width := 400; width <= 507 && !found; width++ {
		spec.ScopePolicy.AllowedPaths = []string{}
		spec.ScopePolicy.ForbiddenPaths = []string{}
		for i := 0; i < 64; i++ {
			prefix := strings.Repeat("a", width-len(string(rune('a'+i%26)))-3) + string(rune('a'+i%26)) + strings.Repeat("z", i%4)
			spec.ScopePolicy.AllowedPaths = append(spec.ScopePolicy.AllowedPaths, "allow"+prefix)
			spec.ScopePolicy.ForbiddenPaths = append(spec.ScopePolicy.ForbiddenPaths, "deny"+prefix)
		}
		specRaw, _ := json.Marshal(spec)
		recordRaw, _ := json.Marshal(taskGrantRecord{Version: 1, Owner: store.owner, Spec: spec, IssuedAt: bindingTime(bindingNow)})
		found = len(specRaw) <= 64<<10 && len(recordRaw) > 64<<10
	}
	if !found {
		t.Fatal("fixture did not cross the complete-record boundary")
	}
	if _, err := store.IssueTaskGrant(context.Background(), spec, bindingNow); !errors.Is(err, ErrLimit) {
		t.Fatal(err)
	}
	if _, err := os.Stat(store.grantPath(spec.GrantID, false)); !os.IsNotExist(err) {
		t.Fatal("oversize consent was installed")
	}
}

func TestTaskGrantConcurrentReplayDoesNotBroadenConsent(t *testing.T) {
	_, store, spec, _ := taskGrantFixture(t, "sha1")
	var wg sync.WaitGroup
	views := make(chan TaskGrantView, 8)
	for i := 0; i < 8; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			v, err := store.IssueTaskGrant(context.Background(), spec, bindingNow)
			if err != nil {
				t.Error(err)
				return
			}
			views <- v
		}()
	}
	wg.Wait()
	close(views)
	var first string
	for v := range views {
		if first == "" {
			first = v.Summary.Grant.Digest
		}
		if first != v.Summary.Grant.Digest {
			t.Error("duplicate consent")
		}
	}
	spec.ScopePolicy.AllowedPaths = []string{"."}
	if _, err := store.IssueTaskGrant(context.Background(), spec, bindingNow); !errors.Is(err, ErrConflict) {
		t.Fatal(err)
	}
	listed, err := store.ListTaskGrants()
	if err != nil || len(listed) != 1 {
		t.Fatal(err)
	}
}

func TestTaskGrantNamespaceAndCorruptRecordsFailClosed(t *testing.T) {
	f, store, spec, m := taskGrantFixture(t, "sha1")
	_, m = issuedTaskManifest(t, store, spec, m)
	file := store.grantPath(spec.GrantID, false)
	original, err := os.ReadFile(file)
	if err != nil {
		t.Fatal(err)
	}
	for _, raw := range [][]byte{
		[]byte(strings.Replace(string(original), `"version":1`, `"version":1,"version":1`, 1)),
		[]byte(strings.Replace(string(original), `"owner"`, `"Owner"`, 1)),
		[]byte(strings.Replace(string(original), `"version":1`, `"version":2`, 1)),
		append(append([]byte{}, original...), []byte("{}")...),
	} {
		if err := os.WriteFile(file, raw, 0o600); err != nil {
			t.Fatal(err)
		}
		if _, err := store.ListTaskGrants(); err == nil {
			t.Fatal("corrupt grant listed")
		}
		if err := store.CheckTaskGrant(context.Background(), m, execution.Prepare, bindingNow); err == nil {
			t.Fatal("corrupt grant admitted")
		}
	}
	if err := os.WriteFile(file, original, 0o600); err != nil {
		t.Fatal(err)
	}
	if err := store.Close(); err != nil {
		t.Fatal(err)
	}
	for _, field := range []string{"central", "team", "device", "owner"} {
		other := store.owner
		switch field {
		case "central":
			other.ServerURL = "https://other.example.invalid"
		case "team":
			other.TeamID = "team_other0001"
		case "device":
			other.DeviceID = "device_other0001"
		case "owner":
			other.OwnerMemberID = "member_other0001"
		}
		newStore, err := OpenBindingStore(context.Background(), store.dataRoot, other, f.executable, Limits{})
		if err != nil {
			t.Fatal(err)
		}
		listed, err := newStore.ListTaskGrants()
		if err != nil || len(listed) != 0 {
			t.Fatal("cross-owner consent visible", err)
		}
		if err := newStore.CheckTaskGrant(context.Background(), m, execution.Prepare, bindingNow); err == nil {
			t.Fatal("cross-owner consent admitted")
		}
		if err := newStore.Close(); err != nil {
			t.Fatal(err)
		}
	}
}

func TestTaskGrantStrictDecodeAndDirectoryFence(t *testing.T) {
	_, store, spec, _ := taskGrantFixture(t, "sha1")
	raw, _ := json.Marshal(spec)
	if _, err := DecodeTaskGrantSpec(raw); err != nil {
		t.Fatal(err)
	}
	for _, bad := range [][]byte{
		[]byte(strings.Replace(string(raw), `"grantId"`, `"GrantId"`, 1)),
		[]byte(strings.Replace(string(raw), `"grantId":`, `"unknown":true,"grantId":`, 1)),
		[]byte(strings.Replace(string(raw), `"bindingRevision":1`, `"bindingRevision":1,"bindingRevision":1`, 1)),
		[]byte(strings.Replace(string(raw), `,"integrationTargets":[]`, "", 1)),
		append(append([]byte{}, raw...), []byte("{}")...),
		[]byte(strings.Repeat(" ", 64<<10+1)),
	} {
		if _, err := DecodeTaskGrantSpec(bad); err == nil {
			t.Fatal("ambiguous owner JSON accepted")
		}
	}
	if err := os.Rename(store.grantRoot, store.grantRoot+"-retained"); err != nil {
		t.Fatal(err)
	}
	if err := os.Mkdir(store.grantRoot, 0o700); err != nil {
		t.Fatal(err)
	}
	if _, err := store.IssueTaskGrant(context.Background(), spec, bindingNow); !errors.Is(err, ErrChanged) {
		t.Fatal(err)
	}
	if entries, err := os.ReadDir(store.grantRoot); err != nil || len(entries) != 0 {
		t.Fatal("replaced directory mutated")
	}
	if _, err := os.Stat(filepath.Join(store.dataRoot, "inbox")); !os.IsNotExist(err) {
		t.Fatal("grant setup created Runtime state")
	}
}

func TestTaskGrantPathIntersectionPreservesDenyAndPreventiveRequirements(t *testing.T) {
	grant := execution.ManifestScopePolicy{Access: execution.IsolatedWrite, AllowedPaths: []string{"src", "tests"}, ForbiddenPaths: []string{"src/private"}, RequirePreventivePathEnforcement: true}
	for _, test := range []struct {
		name          string
		access        execution.Access
		allow, deny   []string
		prevent, want bool
	}{
		{"same", execution.IsolatedWrite, []string{"src", "tests"}, []string{"src/private"}, true, true},
		{"narrow", execution.IsolatedWrite, []string{"src/public"}, []string{}, true, true},
		{"deny wins", execution.IsolatedWrite, []string{"src"}, []string{}, true, false},
		{"broader deny", execution.IsolatedWrite, []string{"src", "tests"}, []string{"src"}, true, true},
		{"partially removed deny", execution.IsolatedWrite, []string{"src"}, []string{"src/private/only"}, true, false},
		{"prefix collision", execution.IsolatedWrite, []string{"src2"}, []string{}, true, false},
		{"enforcement downgrade", execution.IsolatedWrite, []string{"tests"}, []string{}, false, false},
		{"read only", execution.ReadOnly, []string{}, []string{}, true, true},
	} {
		t.Run(test.name, func(t *testing.T) {
			request := execution.ManifestScopePolicy{Access: test.access, AllowedPaths: test.allow, ForbiddenPaths: test.deny, RequirePreventivePathEnforcement: test.prevent}
			if got := scopeWithinGrant(request, grant); got != test.want {
				t.Fatalf("got %v want %v", got, test.want)
			}
		})
	}
	grant.Access = execution.ReadOnly
	grant.AllowedPaths = []string{}
	request := execution.ManifestScopePolicy{Access: execution.IsolatedWrite, AllowedPaths: []string{"tests"}, ForbiddenPaths: []string{}, RequirePreventivePathEnforcement: true}
	if scopeWithinGrant(request, grant) {
		t.Fatal("read-only consent upgraded to writer")
	}
}
