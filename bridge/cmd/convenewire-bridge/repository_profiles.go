package main

import (
	"encoding/json"
	"flag"
	"fmt"
	"io"
	"time"

	"convenewire.dev/bridge/internal/admission"
	"convenewire.dev/bridge/internal/identity"
)

func repositoryProfileCommand(args []string, output io.Writer, clock func() time.Time) error {
	if len(args) == 0 || (args[0] != "register" && args[0] != "list" && args[0] != "revoke") {
		return fmt.Errorf("repository profile requires register, list, or revoke; a profile is not Runtime startup authority")
	}
	flags := flag.NewFlagSet("repository profile "+args[0], flag.ContinueOnError)
	configPath := flags.String("config", "", "local Bridge configuration")
	var profileID, agentID, permissionProfile, expectedDigest string
	var expectedRevision int64
	var confirm bool
	if args[0] != "list" {
		flags.BoolVar(&confirm, "confirm", false, "confirm exact profile registration or revocation")
		flags.StringVar(&profileID, "profile-id", "", "exact profile_ identity")
	}
	if args[0] == "register" {
		flags.StringVar(&agentID, "agent-id", "", "existing configured Agent identity")
		flags.StringVar(&permissionProfile, "permission-profile", "", "exact installed Codex permission profile name")
	}
	if args[0] == "revoke" {
		flags.Int64Var(&expectedRevision, "expected-revision", 0, "reviewed registration revision (1)")
		flags.StringVar(&expectedDigest, "expected-digest", "", "reviewed immutable profile digest")
	}
	if err := flags.Parse(args[1:]); err != nil {
		return err
	}
	if flags.NArg() != 0 || (args[0] != "list" && !confirm) {
		return fmt.Errorf("profile mutations require --confirm and no positional arguments")
	}
	if args[0] == "register" && (profileID == "" || agentID == "" || permissionProfile == "") {
		return fmt.Errorf("profile register requires --profile-id, --agent-id, --permission-profile and --confirm")
	}
	if args[0] == "revoke" && (profileID == "" || expectedRevision != 1 || expectedDigest == "") {
		return fmt.Errorf("profile revoke requires --profile-id, --expected-revision 1, --expected-digest and --confirm")
	}
	session, err := openLocalOwner(*configPath, args[0] == "register", clock)
	if err != nil {
		return err
	}
	defer session.Close()
	store, err := admission.OpenProfileStore(session.Context, session.DataDir, session.ProfileOwner())
	if err != nil {
		return err
	}
	defer store.Close()
	var result any
	switch args[0] {
	case "register":
		agent, lookupErr := identity.LookupConfigured(session.DataDir, session.Config.Agents, agentID)
		if lookupErr != nil {
			return lookupErr
		}
		configurationDigest, digestErr := admission.CodexConfigurationDigest(agent, agentID, permissionProfile)
		if digestErr != nil {
			return digestErr
		}
		result, err = store.RegisterCodex(session.Context, admission.CodexRegistration{Spec: admission.RuntimeProfileSpec{
			ProfileID: profileID, Revision: 1, AgentID: agentID, RuntimeKind: admission.CodexRuntimeKind,
			ConfigurationDigest: configurationDigest, PermissionProfile: permissionProfile}, Agent: agent}, clock())
		if err != nil {
			return err
		}
	case "list":
		result, err = store.List()
	case "revoke":
		result, err = store.Revoke(profileID, expectedRevision, expectedDigest, clock())
	}
	if err != nil {
		return err
	}
	return json.NewEncoder(output).Encode(result)
}
