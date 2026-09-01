package admission

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
	"time"

	"convenewire.dev/bridge/internal/config"
	"convenewire.dev/bridge/internal/pairing"
	"convenewire.dev/bridge/internal/repository"
	bridgeruntime "convenewire.dev/bridge/internal/runtime"
	"convenewire.dev/bridge/internal/verification"
	contracts "convenewire.dev/contracts/generated/go"
	execution "convenewire.dev/contracts/generated/go/execution"
)

type httpVerificationProfile struct {
	ProfileID           string `json:"profileId"`
	Revision            int64  `json:"revision"`
	Digest              string `json:"digest"`
	Mode                string `json:"mode"`
	TimeoutMilliseconds int64  `json:"timeoutMilliseconds"`
}

type httpVerificationProfiles struct {
	executable string
	digest     string
	marker     string
	profiles   []httpVerificationProfile
}

func (p *httpVerificationProfiles) Resolve(reference verification.Reference) (verification.ResolvedProfile, error) {
	for _, profile := range p.profiles {
		if profile.ProfileID == reference.ProfileID && profile.Revision == reference.Revision &&
			profile.Digest == reference.Digest {
			return verification.ResolvedProfile{Reference: reference, Executable: p.executable,
				ExecutableDigest: p.digest, Arguments: []string{
					"-test.run=^TestGovernedVerificationHTTPCommand$", "--", profile.Mode, p.marker,
				}, Timeout: time.Duration(profile.TimeoutMilliseconds) * time.Millisecond,
				OutputLimitBytes: 4096}, nil
		}
	}
	return verification.ResolvedProfile{}, verification.ErrProfileConflict
}

type httpVerificationBindings struct {
	manifest execution.GovernedExecutionManifest
}

func (b *httpVerificationBindings) CheckTaskGrant(_ context.Context,
	manifest execution.GovernedExecutionManifest, operation execution.KindElement, _ time.Time) error {
	if operation != execution.Verify || !reflect.DeepEqual(manifest, b.manifest) {
		return ErrProfileDenied
	}
	return nil
}

func (*httpVerificationBindings) ResolveSource(context.Context, string, string, int) (repository.Source, error) {
	return repository.Source{}, errors.New("verification fixture does not resolve owner source")
}

type httpVerificationFence struct{ view RuntimeAdmissionView }

func (f httpVerificationFence) Get(runID string) (RuntimeAdmissionView, error) {
	if runID != f.view.Spec.RunID {
		return RuntimeAdmissionView{}, ErrAdmissionChanged
	}
	return f.view, nil
}

type httpVerificationProcess struct{}

func (httpVerificationProcess) RequireFinished(bridgeruntime.GovernedProcessIdentity) error {
	return nil
}

// Driven only by the Server verification integration test. It joins the real
// captured Git candidate, real verifier child processes and real Central HTTP
// receipt authority without introducing a production bypass command.
func TestGovernedVerificationHTTPProcess(t *testing.T) {
	if os.Getenv("CONVENE_WIRE_VERIFICATION_HTTP_PROCESS") != "1" {
		t.Skip("Server-driven verification process fixture")
	}
	var input struct {
		ServerURL, Token, StatePath, DataPath, TemporaryParent, MarkerPath string
		Request                                                            contracts.RunRequestedPayload
		Manifest                                                           execution.GovernedExecutionManifest
		Checkpoint                                                         execution.RepositoryCheckpoint
		Profiles                                                           []httpVerificationProfile
	}
	decoder := json.NewDecoder(io.LimitReader(os.Stdin, 2<<20))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&input); err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	manifest, err := DecodeGovernedManifest(input.Request)
	if err != nil || !reflect.DeepEqual(manifest, input.Manifest) {
		t.Fatalf("governed request changed: %v", err)
	}
	git, err := exec.LookPath("git")
	if err != nil {
		t.Fatal(err)
	}
	git, err = filepath.Abs(git)
	if err != nil {
		t.Fatal(err)
	}
	preparer, err := repository.NewPreparer(input.StatePath, git, repository.Limits{})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = preparer.Close() })
	executable, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	rawExecutable, err := os.ReadFile(executable)
	if err != nil {
		t.Fatal(err)
	}
	executableHash := sha256.Sum256(rawExecutable)
	owner := verification.Owner{ServerURL: input.ServerURL, TeamID: "team_http_verification",
		DeviceID: manifest.Scope.DeviceID, OwnerMemberID: "member_http_verification"}
	journal, err := verification.OpenJournal(input.DataPath, owner)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = journal.Close() })
	startDigest := strings.Repeat("b", 64)
	spec := RuntimeAdmissionSpec{RunID: manifest.Scope.RunID}
	view := RuntimeAdmissionView{Spec: spec, AdmissionDigest: strings.Repeat("a", 64),
		State: RuntimeAdmissionStarting, StartDigest: &startDigest}
	profiles := &httpVerificationProfiles{executable: executable,
		digest: hex.EncodeToString(executableHash[:]), marker: input.MarkerPath,
		profiles: input.Profiles}
	client := verification.NewClient(config.Config{ServerURL: input.ServerURL}, pairing.Credential{
		Token: input.Token, ServerURL: input.ServerURL,
	})
	coordinator, err := newGovernedVerificationCoordinator(
		&httpVerificationBindings{manifest: manifest}, preparer, profiles, journal,
		httpVerificationFence{view: view}, httpVerificationProcess{}, client,
		verification.Runner{TemporaryParent: input.TemporaryParent},
	)
	if err != nil {
		t.Fatal(err)
	}
	coordinator.now = time.Now
	ticket := GovernedAdmissionTicket{request: input.Request, manifest: manifest,
		prepared: repository.PreparedWorkspace{Path: input.StatePath}, admission: view}
	decision := GovernedStartDecision{View: view, Invoke: true, workspace: input.StatePath}
	receipts, err := coordinator.VerifyCaptured(ctx, ticket, decision, input.Checkpoint)
	result := struct {
		Receipts []verification.RetainedReceipt `json:"receipts"`
		Error    string                         `json:"error"`
	}{Receipts: receipts}
	if err != nil {
		result.Error = err.Error()
	}
	encoded, marshalErr := json.Marshal(result)
	if marshalErr != nil {
		t.Fatal(marshalErr)
	}
	fmt.Println("VERIFICATION_RESULT " + string(encoded))
}

func TestGovernedVerificationHTTPCommand(t *testing.T) {
	if len(os.Args) < 5 || os.Args[1] != "-test.run=^TestGovernedVerificationHTTPCommand$" ||
		os.Args[2] != "--" {
		return
	}
	mode, marker := os.Args[3], os.Args[4]
	appendMarker := func(state string) {
		file, err := os.OpenFile(marker, os.O_CREATE|os.O_APPEND|os.O_WRONLY, 0o600)
		if err != nil {
			os.Exit(91)
		}
		_, _ = fmt.Fprintf(file, "%s:%s\n", mode, state)
		_ = file.Close()
	}
	appendMarker("started")
	workingDirectory, _ := os.Getwd()
	fmt.Fprintln(os.Stdout, "verified candidate", workingDirectory)
	switch mode {
	case "pass":
		appendMarker("completed")
		os.Exit(0)
	case "fail":
		fmt.Fprintln(os.Stderr, "verification failed")
		appendMarker("completed")
		os.Exit(7)
	case "timeout":
		time.Sleep(5 * time.Second)
		appendMarker("completed")
		os.Exit(0)
	default:
		os.Exit(92)
	}
}
