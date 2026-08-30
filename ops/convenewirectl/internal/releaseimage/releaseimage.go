package releaseimage

import (
	"archive/tar"
	"bufio"
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"hash"
	"io"
	"io/fs"
	"os"
	"path"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
)

const (
	MetadataSchemaVersion = 2
	OCIIndexMediaType     = "application/vnd.oci.image.index.v1+json"
	OCIManifestMediaType  = "application/vnd.oci.image.manifest.v1+json"
	OCIConfigMediaType    = "application/vnd.oci.image.config.v1+json"
	InTotoMediaType       = "application/vnd.in-toto+json"
	SPDXPredicateType     = "https://spdx.dev/Document"
	SLSAPredicateType     = "https://slsa.dev/provenance/v1"
	ServerRole            = "server"
	CaddyRole             = "caddy"
	ServerRepository      = "convenewire/server"
	CaddyRepository       = "convenewire/caddy"
	SourceRepositoryURI   = "git+https://github.com/chenrgSix/ConveneWire"
	SBOMGenerator         = "docker.io/docker/buildkit-syft-scanner@sha256:ae4f3b554449e7e25548e7d8ccc029d17357348e30c6e3df01b92bc93654d6a9"
	maxJSONBytes          = 64 << 20
	maxEntries            = 100_000
)

var (
	sha256Pattern    = regexp.MustCompile(`^sha256:[0-9a-f]{64}$`)
	hexSHA256Pattern = regexp.MustCompile(`^[0-9a-f]{64}$`)
	blobPathPattern  = regexp.MustCompile(`^blobs/sha256/[0-9a-f]{64}$`)
	commitPattern    = regexp.MustCompile(`^[0-9a-f]{40,64}$`)
	platformPattern  = regexp.MustCompile(`^linux/(amd64|arm64)$`)
)

type Metadata struct {
	SchemaVersion  int             `json:"schemaVersion"`
	ReleaseVersion string          `json:"releaseVersion"`
	SourceCommit   string          `json:"sourceCommit"`
	Platform       string          `json:"platform"`
	Archive        string          `json:"archive"`
	ArchiveSHA256  string          `json:"archiveSha256"`
	Images         []ImageMetadata `json:"images"`
	Provenance     Attestation     `json:"provenance"`
	BuilderID      string          `json:"builderId"`
	SBOMGenerator  string          `json:"sbomGenerator"`
}

type ImageMetadata struct {
	Role             string      `json:"role"`
	Repository       string      `json:"repository"`
	Digest           string      `json:"digest"`
	Reference        string      `json:"reference"`
	RuntimeReference string      `json:"runtimeReference"`
	SBOM             Attestation `json:"sbom"`
}

type Attestation struct {
	Path          string `json:"path"`
	SHA256        string `json:"sha256"`
	PredicateType string `json:"predicateType"`
}

type RawImage struct {
	Role       string
	Repository string
	Archive    string
}

type FinalizeOptions struct {
	Images             []RawImage
	OutputArchive      string
	OutputMetadata     string
	EmbeddedArchive    string
	ReleaseVersion     string
	SourceCommit       string
	Platform           string
	BuilderID          string
	BuildInvocationURI string
}

type descriptor struct {
	MediaType   string            `json:"mediaType"`
	Digest      string            `json:"digest"`
	Size        int64             `json:"size"`
	Annotations map[string]string `json:"annotations,omitempty"`
	Platform    *platform         `json:"platform,omitempty"`
}

type platform struct {
	Architecture string `json:"architecture"`
	OS           string `json:"os"`
}

type imageIndex struct {
	SchemaVersion int          `json:"schemaVersion"`
	MediaType     string       `json:"mediaType"`
	Manifests     []descriptor `json:"manifests"`
}

type imageManifest struct {
	SchemaVersion int          `json:"schemaVersion"`
	MediaType     string       `json:"mediaType"`
	Config        descriptor   `json:"config"`
	Layers        []descriptor `json:"layers"`
}

type dockerManifestItem struct {
	Config   string   `json:"Config"`
	RepoTags []string `json:"RepoTags"`
	Layers   []string `json:"Layers"`
}

type imageConfig struct {
	Architecture string `json:"architecture"`
	OS           string `json:"os"`
	Config       struct {
		Labels map[string]string `json:"Labels"`
	} `json:"config"`
}

type inTotoStatement struct {
	Type          string          `json:"_type"`
	Subject       []subject       `json:"subject"`
	PredicateType string          `json:"predicateType"`
	Predicate     json.RawMessage `json:"predicate"`
}

type subject struct {
	Name   string            `json:"name"`
	Digest map[string]string `json:"digest"`
}

type provenancePredicate struct {
	BuildDefinition struct {
		BuildType          string `json:"buildType"`
		ExternalParameters struct {
			ReleaseVersion string `json:"releaseVersion"`
			SourceCommit   string `json:"sourceCommit"`
			Platform       string `json:"platform"`
		} `json:"externalParameters"`
		ResolvedDependencies []struct {
			URI    string            `json:"uri"`
			Digest map[string]string `json:"digest"`
		} `json:"resolvedDependencies"`
	} `json:"buildDefinition"`
	RunDetails struct {
		Builder struct {
			ID string `json:"id"`
		} `json:"builder"`
		Metadata struct {
			InvocationID string `json:"invocationId,omitempty"`
		} `json:"metadata"`
	} `json:"runDetails"`
}

type archiveScan struct {
	SmallFiles map[string][]byte
	Sizes      map[string]int64
	BlobHashes map[string]string
	Names      map[string]struct{}
}

type rawResolved struct {
	Role             string
	Repository       string
	Primary          descriptor
	Manifest         imageManifest
	RequiredBlobs    map[string]struct{}
	SBOMStatement    []byte
	SBOMInternalPath string
}

func (metadata Metadata) Image(role string) (ImageMetadata, bool) {
	for _, image := range metadata.Images {
		if image.Role == role {
			return image, true
		}
	}
	return ImageMetadata{}, false
}

func Finalize(options FinalizeOptions) (Metadata, error) {
	if err := validateFinalizeOptions(options); err != nil {
		return Metadata{}, err
	}
	resolved := make([]rawResolved, 0, len(options.Images))
	for _, image := range options.Images {
		scan, err := scanArchive(image.Archive, false)
		if err != nil {
			return Metadata{}, fmt.Errorf("inspect raw %s image: %w", image.Role, err)
		}
		value, err := resolveRawImage(scan, image, options)
		if err != nil {
			return Metadata{}, fmt.Errorf("inspect raw %s image: %w", image.Role, err)
		}
		resolved = append(resolved, value)
	}
	sort.Slice(resolved, func(left, right int) bool {
		return roleOrder(resolved[left].Role) < roleOrder(resolved[right].Role)
	})

	provenanceBytes, err := buildProvenance(options, resolved)
	if err != nil {
		return Metadata{}, err
	}
	metadata, err := writeFinalArchive(options, resolved, provenanceBytes)
	if err != nil {
		return Metadata{}, err
	}
	if _, err := verifyArchiveAndMetadata(options.OutputArchive, metadata); err != nil {
		return Metadata{}, fmt.Errorf("verify finalized image bundle: %w", err)
	}
	if err := writeJSONAtomic(options.OutputMetadata, metadata, 0o644); err != nil {
		return Metadata{}, fmt.Errorf("write image metadata: %w", err)
	}
	return metadata, nil
}

func validateFinalizeOptions(options FinalizeOptions) error {
	if len(options.Images) != 2 {
		return fmt.Errorf("exactly two runtime images are required")
	}
	if !commitPattern.MatchString(options.SourceCommit) {
		return fmt.Errorf("source commit must be a full lowercase commit hash")
	}
	if !platformPattern.MatchString(options.Platform) {
		return fmt.Errorf("platform must be linux/amd64 or linux/arm64")
	}
	if options.ReleaseVersion == "" || options.BuilderID == "" {
		return fmt.Errorf("release version and builder identity are required")
	}
	if err := validateRelativePath(options.EmbeddedArchive); err != nil || !strings.HasPrefix(options.EmbeddedArchive, "image/") {
		return fmt.Errorf("embedded archive path must be a safe image/ path")
	}
	roles := map[string]string{}
	for _, image := range options.Images {
		if image.Role != ServerRole && image.Role != CaddyRole {
			return fmt.Errorf("unsupported runtime image role %q", image.Role)
		}
		if image.Repository != expectedRepository(image.Role) {
			return fmt.Errorf("runtime image %s has unexpected repository %q", image.Role, image.Repository)
		}
		if roles[image.Role] != "" {
			return fmt.Errorf("duplicate runtime image role %q", image.Role)
		}
		roles[image.Role] = image.Archive
	}
	if roles[ServerRole] == "" || roles[CaddyRole] == "" {
		return fmt.Errorf("server and caddy runtime images are both required")
	}
	return nil
}

func resolveRawImage(scan archiveScan, image RawImage, options FinalizeOptions) (rawResolved, error) {
	rootBytes, found := scan.SmallFiles["index.json"]
	if !found {
		return rawResolved{}, fmt.Errorf("OCI index.json is missing or too large")
	}
	index, err := decodeIndex(rootBytes)
	if err != nil {
		return rawResolved{}, err
	}
	if len(index.Manifests) == 1 && index.Manifests[0].MediaType == OCIIndexMediaType {
		inner, err := descriptorBytes(scan, index.Manifests[0])
		if err != nil {
			return rawResolved{}, err
		}
		index, err = decodeIndex(inner)
		if err != nil {
			return rawResolved{}, err
		}
	}
	expectedOS, expectedArch, _ := strings.Cut(options.Platform, "/")
	var primary descriptor
	for _, candidate := range index.Manifests {
		if candidate.Annotations["vnd.docker.reference.type"] == "attestation-manifest" {
			continue
		}
		if candidate.MediaType != OCIManifestMediaType || candidate.Platform == nil ||
			candidate.Platform.OS != expectedOS || candidate.Platform.Architecture != expectedArch {
			continue
		}
		if primary.Digest != "" {
			return rawResolved{}, fmt.Errorf("OCI layout contains multiple primary %s manifests", options.Platform)
		}
		primary = candidate
	}
	if primary.Digest == "" {
		return rawResolved{}, fmt.Errorf("OCI layout has no primary %s manifest", options.Platform)
	}
	manifestBytes, err := descriptorBytes(scan, primary)
	if err != nil {
		return rawResolved{}, err
	}
	manifest, err := decodeManifest(manifestBytes)
	if err != nil {
		return rawResolved{}, err
	}
	configBytes, err := descriptorBytes(scan, manifest.Config)
	if err != nil {
		return rawResolved{}, err
	}
	if err := validateConfig(configBytes, options.Platform, options.ReleaseVersion, options.SourceCommit); err != nil {
		return rawResolved{}, err
	}

	var sbom []byte
	for _, candidate := range index.Manifests {
		if candidate.Annotations["vnd.docker.reference.type"] != "attestation-manifest" ||
			candidate.Annotations["vnd.docker.reference.digest"] != primary.Digest {
			continue
		}
		attestationBytes, err := descriptorBytes(scan, candidate)
		if err != nil {
			return rawResolved{}, err
		}
		attestation, err := decodeManifest(attestationBytes)
		if err != nil {
			return rawResolved{}, err
		}
		for _, layer := range attestation.Layers {
			if layer.MediaType != InTotoMediaType || layer.Annotations["in-toto.io/predicate-type"] != SPDXPredicateType {
				continue
			}
			if sbom != nil {
				return rawResolved{}, fmt.Errorf("OCI layout contains duplicate SBOM attestations")
			}
			sbom, err = descriptorBytes(scan, layer)
			if err != nil {
				return rawResolved{}, err
			}
		}
	}
	if sbom == nil {
		return rawResolved{}, fmt.Errorf("OCI layout does not contain an SPDX SBOM attestation")
	}
	if err := validateSBOMStatement(sbom, image.Repository, primary.Digest); err != nil {
		return rawResolved{}, err
	}

	required := map[string]struct{}{primary.Digest: {}, manifest.Config.Digest: {}}
	for _, layer := range manifest.Layers {
		if err := validateDescriptor(scan, layer); err != nil {
			return rawResolved{}, err
		}
		required[layer.Digest] = struct{}{}
	}
	return rawResolved{
		Role: image.Role, Repository: image.Repository, Primary: primary,
		Manifest: manifest, RequiredBlobs: required, SBOMStatement: sbom,
		SBOMInternalPath: "attestations/" + image.Role + ".sbom.spdx.json",
	}, nil
}

func writeFinalArchive(options FinalizeOptions, resolved []rawResolved, provenance []byte) (Metadata, error) {
	if err := os.MkdirAll(filepath.Dir(options.OutputArchive), 0o755); err != nil {
		return Metadata{}, err
	}
	temporary, err := os.CreateTemp(filepath.Dir(options.OutputArchive), ".central-image-*.tmp")
	if err != nil {
		return Metadata{}, err
	}
	temporaryPath := temporary.Name()
	remove := true
	defer func() {
		_ = temporary.Close()
		if remove {
			_ = os.Remove(temporaryPath)
		}
	}()
	writer := tar.NewWriter(temporary)
	if err := writeTarDirectory(writer, "blobs/"); err != nil {
		return Metadata{}, err
	}
	if err := writeTarDirectory(writer, "blobs/sha256/"); err != nil {
		return Metadata{}, err
	}
	if err := writeTarDirectory(writer, "attestations/"); err != nil {
		return Metadata{}, err
	}
	if err := writeTarFile(writer, "oci-layout", []byte("{\"imageLayoutVersion\":\"1.0.0\"}\n")); err != nil {
		return Metadata{}, err
	}

	root := imageIndex{SchemaVersion: 2, MediaType: OCIIndexMediaType}
	for _, image := range resolved {
		descriptor := image.Primary
		descriptor.Annotations = map[string]string{
			"io.containerd.image.name":          "docker.io/" + image.Repository + ":" + options.ReleaseVersion,
			"org.opencontainers.image.ref.name": options.ReleaseVersion,
		}
		root.Manifests = append(root.Manifests, descriptor)
	}
	rootBytes, err := json.Marshal(root)
	if err != nil {
		return Metadata{}, err
	}
	if err := writeTarFile(writer, "index.json", append(rootBytes, '\n')); err != nil {
		return Metadata{}, err
	}
	dockerManifest := make([]dockerManifestItem, 0, len(resolved))
	for _, image := range resolved {
		layers := make([]string, 0, len(image.Manifest.Layers))
		for _, layer := range image.Manifest.Layers {
			layers = append(layers, dockerBlobPath(layer.Digest))
		}
		dockerManifest = append(dockerManifest, dockerManifestItem{
			Config:   dockerBlobPath(image.Manifest.Config.Digest),
			RepoTags: []string{image.Repository + ":" + options.ReleaseVersion},
			Layers:   layers,
		})
	}
	dockerManifestBytes, err := json.Marshal(dockerManifest)
	if err != nil {
		return Metadata{}, err
	}
	if err := writeTarFile(writer, "manifest.json", append(dockerManifestBytes, '\n')); err != nil {
		return Metadata{}, err
	}

	writtenBlobs := map[string]struct{}{}
	for _, image := range resolved {
		if err := copySelectedBlobs(writer, options.Images, image.RequiredBlobs, writtenBlobs); err != nil {
			return Metadata{}, err
		}
		if err := writeTarFile(writer, image.SBOMInternalPath, image.SBOMStatement); err != nil {
			return Metadata{}, err
		}
	}
	provenancePath := "attestations/provenance.slsa.json"
	if err := writeTarFile(writer, provenancePath, provenance); err != nil {
		return Metadata{}, err
	}
	if err := writer.Close(); err != nil {
		return Metadata{}, err
	}
	if err := temporary.Sync(); err != nil {
		return Metadata{}, err
	}
	if err := temporary.Close(); err != nil {
		return Metadata{}, err
	}
	if err := os.Rename(temporaryPath, options.OutputArchive); err != nil {
		return Metadata{}, err
	}
	remove = false

	archiveSHA, err := digestFile(options.OutputArchive)
	if err != nil {
		return Metadata{}, err
	}
	metadata := Metadata{
		SchemaVersion: MetadataSchemaVersion, ReleaseVersion: options.ReleaseVersion,
		SourceCommit: options.SourceCommit, Platform: options.Platform,
		Archive: options.EmbeddedArchive, ArchiveSHA256: archiveSHA,
		BuilderID:     options.BuilderID,
		SBOMGenerator: SBOMGenerator,
		Provenance: Attestation{
			Path: provenancePath, SHA256: digestBytes(provenance), PredicateType: SLSAPredicateType,
		},
	}
	for _, image := range resolved {
		metadata.Images = append(metadata.Images, ImageMetadata{
			Role: image.Role, Repository: image.Repository, Digest: image.Primary.Digest,
			Reference: image.Repository + "@" + image.Primary.Digest, RuntimeReference: image.Manifest.Config.Digest,
			SBOM: Attestation{
				Path: image.SBOMInternalPath, SHA256: digestBytes(image.SBOMStatement), PredicateType: SPDXPredicateType,
			},
		})
	}
	return metadata, nil
}

func copySelectedBlobs(writer *tar.Writer, rawImages []RawImage, selected, written map[string]struct{}) error {
	remaining := map[string]struct{}{}
	for digest := range selected {
		if _, exists := written[digest]; !exists {
			remaining[digest] = struct{}{}
		}
	}
	for _, raw := range rawImages {
		if len(remaining) == 0 {
			break
		}
		file, err := os.Open(raw.Archive)
		if err != nil {
			return err
		}
		reader := tar.NewReader(bufio.NewReader(file))
		for {
			header, err := reader.Next()
			if errors.Is(err, io.EOF) {
				break
			}
			if err != nil {
				_ = file.Close()
				return err
			}
			digest := strings.TrimPrefix(header.Name, "blobs/sha256/")
			full := "sha256:" + digest
			if _, wanted := remaining[full]; !wanted || !strings.HasPrefix(header.Name, "blobs/sha256/") {
				continue
			}
			copyHeader := &tar.Header{Name: header.Name, Mode: 0o644, Size: header.Size, Typeflag: tar.TypeReg}
			if err := writer.WriteHeader(copyHeader); err != nil {
				_ = file.Close()
				return err
			}
			if _, err := io.CopyN(writer, reader, header.Size); err != nil {
				_ = file.Close()
				return err
			}
			delete(remaining, full)
			written[full] = struct{}{}
		}
		if err := file.Close(); err != nil {
			return err
		}
	}
	if len(remaining) != 0 {
		missing := make([]string, 0, len(remaining))
		for digest := range remaining {
			missing = append(missing, digest)
		}
		sort.Strings(missing)
		return fmt.Errorf("raw OCI archives omit selected blobs: %s", strings.Join(missing, ", "))
	}
	return nil
}

func buildProvenance(options FinalizeOptions, images []rawResolved) ([]byte, error) {
	predicate := provenancePredicate{}
	predicate.BuildDefinition.BuildType = "https://convenewire.dev/buildtypes/central-oci-bundle/v1"
	predicate.BuildDefinition.ExternalParameters.ReleaseVersion = options.ReleaseVersion
	predicate.BuildDefinition.ExternalParameters.SourceCommit = options.SourceCommit
	predicate.BuildDefinition.ExternalParameters.Platform = options.Platform
	predicate.BuildDefinition.ResolvedDependencies = append(
		predicate.BuildDefinition.ResolvedDependencies,
		struct {
			URI    string            `json:"uri"`
			Digest map[string]string `json:"digest"`
		}{
			URI:    SourceRepositoryURI,
			Digest: map[string]string{"gitCommit": options.SourceCommit},
		},
	)
	predicate.BuildDefinition.ResolvedDependencies = append(
		predicate.BuildDefinition.ResolvedDependencies,
		struct {
			URI    string            `json:"uri"`
			Digest map[string]string `json:"digest"`
		}{
			URI:    "oci://" + SBOMGenerator,
			Digest: map[string]string{"sha256": strings.TrimPrefix(strings.SplitN(SBOMGenerator, "@", 2)[1], "sha256:")},
		},
	)
	predicate.RunDetails.Builder.ID = options.BuilderID
	predicate.RunDetails.Metadata.InvocationID = options.BuildInvocationURI
	predicateBytes, err := json.Marshal(predicate)
	if err != nil {
		return nil, err
	}
	statement := inTotoStatement{
		Type: "https://in-toto.io/Statement/v1", PredicateType: SLSAPredicateType,
		Predicate: predicateBytes,
	}
	for _, image := range images {
		statement.Subject = append(statement.Subject, subject{
			Name:   image.Repository,
			Digest: map[string]string{"sha256": strings.TrimPrefix(image.Primary.Digest, "sha256:")},
		})
	}
	value, err := json.MarshalIndent(statement, "", "  ")
	if err != nil {
		return nil, err
	}
	return append(value, '\n'), nil
}

func VerifyBundle(bundleRoot, metadataRelative, releaseVersion, sourceCommit, targetArch string) (Metadata, error) {
	if err := validateRelativePath(metadataRelative); err != nil || !strings.HasPrefix(metadataRelative, "image/") {
		return Metadata{}, fmt.Errorf("image metadata path is unsafe")
	}
	metadataPath := filepath.Join(bundleRoot, filepath.FromSlash(metadataRelative))
	metadataBytes, err := os.ReadFile(metadataPath)
	if err != nil {
		return Metadata{}, fmt.Errorf("read image metadata: %w", err)
	}
	var metadata Metadata
	if err := decodeStrict(metadataBytes, &metadata); err != nil {
		return Metadata{}, fmt.Errorf("decode image metadata: %w", err)
	}
	if metadata.ReleaseVersion != releaseVersion || metadata.SourceCommit != sourceCommit ||
		metadata.Platform != "linux/"+targetArch {
		return Metadata{}, fmt.Errorf("image metadata release, source, or platform does not match Central metadata")
	}
	if err := validateRelativePath(metadata.Archive); err != nil || !strings.HasPrefix(metadata.Archive, "image/") {
		return Metadata{}, fmt.Errorf("image archive path is unsafe")
	}
	archivePath := filepath.Join(bundleRoot, filepath.FromSlash(metadata.Archive))
	if _, err := verifyArchiveAndMetadata(archivePath, metadata); err != nil {
		return Metadata{}, err
	}
	return metadata, nil
}

func verifyArchiveAndMetadata(archivePath string, metadata Metadata) (archiveScan, error) {
	if err := validateMetadata(metadata); err != nil {
		return archiveScan{}, err
	}
	digest, err := digestFile(archivePath)
	if err != nil {
		return archiveScan{}, fmt.Errorf("read image archive: %w", err)
	}
	if digest != metadata.ArchiveSHA256 {
		return archiveScan{}, fmt.Errorf("image archive SHA-256 does not match metadata")
	}
	scan, err := scanArchive(archivePath, true)
	if err != nil {
		return archiveScan{}, err
	}
	if err := verifyFinalLayout(scan, metadata); err != nil {
		return archiveScan{}, err
	}
	return scan, nil
}

func validateMetadata(metadata Metadata) error {
	if metadata.SchemaVersion != MetadataSchemaVersion || metadata.ReleaseVersion == "" ||
		!commitPattern.MatchString(metadata.SourceCommit) || !platformPattern.MatchString(metadata.Platform) ||
		!hexSHA256Pattern.MatchString(metadata.ArchiveSHA256) || metadata.BuilderID == "" ||
		metadata.SBOMGenerator != SBOMGenerator {
		return fmt.Errorf("image metadata identity is invalid")
	}
	if len(metadata.Images) != 2 {
		return fmt.Errorf("image metadata must contain exactly server and caddy")
	}
	seen := map[string]bool{}
	for _, image := range metadata.Images {
		if seen[image.Role] || image.Repository != expectedRepository(image.Role) ||
			!sha256Pattern.MatchString(image.Digest) || image.Reference != image.Repository+"@"+image.Digest ||
			!sha256Pattern.MatchString(image.RuntimeReference) ||
			image.SBOM.Path != "attestations/"+image.Role+".sbom.spdx.json" ||
			image.SBOM.PredicateType != SPDXPredicateType || !hexSHA256Pattern.MatchString(image.SBOM.SHA256) {
			return fmt.Errorf("image metadata for role %q is invalid", image.Role)
		}
		if err := validateAttestationPath(image.SBOM.Path); err != nil {
			return err
		}
		seen[image.Role] = true
	}
	if !seen[ServerRole] || !seen[CaddyRole] || metadata.Provenance.Path != "attestations/provenance.slsa.json" ||
		metadata.Provenance.PredicateType != SLSAPredicateType ||
		!hexSHA256Pattern.MatchString(metadata.Provenance.SHA256) {
		return fmt.Errorf("image metadata attestations are incomplete")
	}
	return validateAttestationPath(metadata.Provenance.Path)
}

func verifyFinalLayout(scan archiveScan, metadata Metadata) error {
	layout := strings.TrimSpace(string(scan.SmallFiles["oci-layout"]))
	if layout != `{"imageLayoutVersion":"1.0.0"}` {
		return fmt.Errorf("OCI layout marker is invalid")
	}
	index, err := decodeIndex(scan.SmallFiles["index.json"])
	if err != nil {
		return err
	}
	if len(index.Manifests) != len(metadata.Images) {
		return fmt.Errorf("OCI index must contain exactly the declared runtime images")
	}
	dockerManifest, err := decodeDockerManifest(scan.SmallFiles["manifest.json"])
	if err != nil {
		return err
	}
	if len(dockerManifest) != len(metadata.Images) {
		return fmt.Errorf("Docker manifest.json must contain exactly the declared runtime images")
	}
	dockerByRole := make(map[string]dockerManifestItem, len(dockerManifest))
	seenDockerConfigs := make(map[string]struct{}, len(dockerManifest))
	for _, item := range dockerManifest {
		if len(item.RepoTags) != 1 {
			return fmt.Errorf("Docker manifest item must contain exactly one role tag")
		}
		role := ""
		for _, image := range metadata.Images {
			if item.RepoTags[0] == image.Repository+":"+metadata.ReleaseVersion {
				role = image.Role
				break
			}
		}
		if role == "" {
			return fmt.Errorf("Docker manifest contains an unexpected role tag %q", item.RepoTags[0])
		}
		if _, duplicate := dockerByRole[role]; duplicate {
			return fmt.Errorf("Docker manifest contains duplicate role tag %q", item.RepoTags[0])
		}
		if _, duplicate := seenDockerConfigs[item.Config]; duplicate {
			return fmt.Errorf("Docker manifest contains duplicate config path %q", item.Config)
		}
		dockerByRole[role] = item
		seenDockerConfigs[item.Config] = struct{}{}
	}
	expectedOS, expectedArch, _ := strings.Cut(metadata.Platform, "/")
	referenced := map[string]struct{}{}
	for _, image := range metadata.Images {
		var selected *descriptor
		for position := range index.Manifests {
			candidate := &index.Manifests[position]
			if candidate.Digest == image.Digest {
				selected = candidate
				break
			}
		}
		if selected == nil || selected.MediaType != OCIManifestMediaType || selected.Platform == nil ||
			selected.Platform.OS != expectedOS || selected.Platform.Architecture != expectedArch ||
			selected.Annotations["io.containerd.image.name"] != "docker.io/"+image.Repository+":"+metadata.ReleaseVersion ||
			selected.Annotations["org.opencontainers.image.ref.name"] != metadata.ReleaseVersion {
			return fmt.Errorf("OCI descriptor for %s does not match metadata", image.Role)
		}
		manifestBytes, err := descriptorBytes(scan, *selected)
		if err != nil {
			return err
		}
		manifest, err := decodeManifest(manifestBytes)
		if err != nil {
			return err
		}
		configBytes, err := descriptorBytes(scan, manifest.Config)
		if err != nil {
			return err
		}
		if err := validateConfig(configBytes, metadata.Platform, metadata.ReleaseVersion, metadata.SourceCommit); err != nil {
			return err
		}
		dockerItem, found := dockerByRole[image.Role]
		if !found {
			return fmt.Errorf("Docker manifest omits %s role tag", image.Role)
		}
		if expected := dockerBlobPath(manifest.Config.Digest); dockerItem.Config != expected {
			return fmt.Errorf("Docker manifest config for %s does not match OCI manifest", image.Role)
		}
		if image.RuntimeReference != manifest.Config.Digest {
			return fmt.Errorf("runtime reference for %s does not match OCI config digest", image.Role)
		}
		expectedLayers := make([]string, 0, len(manifest.Layers))
		for _, layer := range manifest.Layers {
			expectedLayers = append(expectedLayers, dockerBlobPath(layer.Digest))
		}
		if !equalStrings(dockerItem.Layers, expectedLayers) {
			return fmt.Errorf("Docker manifest layers for %s do not match OCI manifest order", image.Role)
		}
		referenced[selected.Digest] = struct{}{}
		referenced[manifest.Config.Digest] = struct{}{}
		for _, layer := range manifest.Layers {
			if err := validateDescriptor(scan, layer); err != nil {
				return err
			}
			referenced[layer.Digest] = struct{}{}
		}
		sbom := scan.SmallFiles[image.SBOM.Path]
		if digestBytes(sbom) != image.SBOM.SHA256 {
			return fmt.Errorf("%s SBOM digest does not match metadata", image.Role)
		}
		if err := validateSBOMStatement(sbom, image.Repository, image.Digest); err != nil {
			return err
		}
	}
	provenance := scan.SmallFiles[metadata.Provenance.Path]
	if digestBytes(provenance) != metadata.Provenance.SHA256 {
		return fmt.Errorf("provenance digest does not match metadata")
	}
	if err := validateProvenance(provenance, metadata); err != nil {
		return err
	}
	for name := range scan.BlobHashes {
		digest := "sha256:" + strings.TrimPrefix(name, "blobs/sha256/")
		if _, ok := referenced[digest]; !ok {
			return fmt.Errorf("OCI archive contains unreferenced blob %s", digest)
		}
	}
	return nil
}

func validateConfig(value []byte, expectedPlatform, releaseVersion, sourceCommit string) error {
	var config imageConfig
	if err := json.Unmarshal(value, &config); err != nil {
		return fmt.Errorf("decode OCI image config: %w", err)
	}
	osName, architecture, _ := strings.Cut(expectedPlatform, "/")
	if config.OS != osName || config.Architecture != architecture ||
		config.Config.Labels["org.opencontainers.image.revision"] != sourceCommit ||
		config.Config.Labels["org.opencontainers.image.version"] != releaseVersion {
		return fmt.Errorf("OCI image config source, version, or platform label is invalid")
	}
	return nil
}

func validateSBOMStatement(value []byte, repository, imageDigest string) error {
	var statement inTotoStatement
	if err := json.Unmarshal(value, &statement); err != nil {
		return fmt.Errorf("decode SPDX SBOM statement: %w", err)
	}
	if statement.PredicateType != SPDXPredicateType || !subjectMatches(statement.Subject, repository, imageDigest) {
		return fmt.Errorf("SPDX SBOM is not bound to %s", repository)
	}
	var predicate struct {
		SPDXVersion string `json:"spdxVersion"`
		SPDXID      string `json:"SPDXID"`
		Packages    []any  `json:"packages"`
	}
	if err := json.Unmarshal(statement.Predicate, &predicate); err != nil ||
		!strings.HasPrefix(predicate.SPDXVersion, "SPDX-2.") || predicate.SPDXID == "" || predicate.Packages == nil {
		return fmt.Errorf("SPDX SBOM predicate is invalid")
	}
	return nil
}

func validateProvenance(value []byte, metadata Metadata) error {
	var statement inTotoStatement
	if err := json.Unmarshal(value, &statement); err != nil {
		return fmt.Errorf("decode SLSA provenance: %w", err)
	}
	if statement.PredicateType != SLSAPredicateType || len(statement.Subject) != len(metadata.Images) {
		return fmt.Errorf("SLSA provenance subjects are incomplete")
	}
	for _, image := range metadata.Images {
		if !subjectMatches(statement.Subject, image.Repository, image.Digest) {
			return fmt.Errorf("SLSA provenance is not bound to %s", image.Repository)
		}
	}
	var predicate provenancePredicate
	if err := json.Unmarshal(statement.Predicate, &predicate); err != nil {
		return fmt.Errorf("decode SLSA provenance predicate: %w", err)
	}
	parameters := predicate.BuildDefinition.ExternalParameters
	if predicate.BuildDefinition.BuildType != "https://convenewire.dev/buildtypes/central-oci-bundle/v1" ||
		parameters.ReleaseVersion != metadata.ReleaseVersion || parameters.SourceCommit != metadata.SourceCommit ||
		parameters.Platform != metadata.Platform || predicate.RunDetails.Builder.ID != metadata.BuilderID {
		return fmt.Errorf("SLSA provenance build identity is invalid")
	}
	sourceFound := false
	generatorFound := false
	for _, dependency := range predicate.BuildDefinition.ResolvedDependencies {
		sourceFound = sourceFound ||
			(dependency.URI == SourceRepositoryURI && dependency.Digest["gitCommit"] == metadata.SourceCommit)
		generatorFound = generatorFound ||
			(dependency.URI == "oci://"+SBOMGenerator &&
				dependency.Digest["sha256"] == strings.TrimPrefix(strings.SplitN(SBOMGenerator, "@", 2)[1], "sha256:"))
	}
	if !sourceFound || !generatorFound {
		return fmt.Errorf("SLSA provenance omits the exact source or SBOM generator")
	}
	return nil
}

func subjectMatches(subjects []subject, repository, imageDigest string) bool {
	wanted := strings.TrimPrefix(imageDigest, "sha256:")
	for _, value := range subjects {
		nameMatches := value.Name == repository ||
			strings.HasPrefix(value.Name, "pkg:docker/"+repository+"@") ||
			strings.HasPrefix(value.Name, "pkg:docker/"+repository+"?")
		if nameMatches && value.Digest["sha256"] == wanted {
			return true
		}
	}
	return false
}

func scanArchive(filename string, allowAttestations bool) (archiveScan, error) {
	file, err := os.Open(filename)
	if err != nil {
		return archiveScan{}, err
	}
	defer file.Close()
	result := archiveScan{
		SmallFiles: map[string][]byte{}, Sizes: map[string]int64{},
		BlobHashes: map[string]string{}, Names: map[string]struct{}{},
	}
	reader := tar.NewReader(bufio.NewReader(file))
	for entryCount := 0; ; entryCount++ {
		if entryCount >= maxEntries {
			return archiveScan{}, fmt.Errorf("OCI archive contains too many entries")
		}
		header, err := reader.Next()
		if errors.Is(err, io.EOF) {
			break
		}
		if err != nil {
			return archiveScan{}, fmt.Errorf("read OCI archive: %w", err)
		}
		name, err := validateTarPath(header.Name, header.Typeflag == tar.TypeDir)
		if err != nil {
			return archiveScan{}, err
		}
		if _, duplicate := result.Names[name]; duplicate {
			return archiveScan{}, fmt.Errorf("OCI archive contains duplicate entry %s", name)
		}
		result.Names[name] = struct{}{}
		if header.Typeflag == tar.TypeDir {
			continue
		}
		if header.Typeflag != tar.TypeReg && header.Typeflag != tar.TypeRegA {
			return archiveScan{}, fmt.Errorf("OCI archive contains non-regular entry %s", name)
		}
		isBlob := blobPathPattern.MatchString(name)
		isKnown := name == "index.json" || name == "oci-layout" || isBlob ||
			(allowAttestations && name == "manifest.json") ||
			(allowAttestations && strings.HasPrefix(name, "attestations/"))
		if !isKnown {
			return archiveScan{}, fmt.Errorf("OCI archive contains unexpected entry %s", name)
		}
		result.Sizes[name] = header.Size
		var destination bytes.Buffer
		var digest hash.Hash
		writers := []io.Writer{}
		if header.Size <= maxJSONBytes {
			writers = append(writers, &destination)
		}
		if isBlob {
			digest = sha256.New()
			writers = append(writers, digest)
		}
		var target io.Writer = io.Discard
		if len(writers) == 1 {
			target = writers[0]
		} else if len(writers) > 1 {
			target = io.MultiWriter(writers...)
		}
		if _, err := io.CopyN(target, reader, header.Size); err != nil {
			return archiveScan{}, err
		}
		if header.Size <= maxJSONBytes {
			result.SmallFiles[name] = destination.Bytes()
		}
		if isBlob {
			actual := hex.EncodeToString(digest.Sum(nil))
			expected := strings.TrimPrefix(name, "blobs/sha256/")
			if actual != expected {
				return archiveScan{}, fmt.Errorf("OCI blob %s has the wrong digest", name)
			}
			result.BlobHashes[name] = actual
		}
	}
	return result, nil
}

func decodeIndex(value []byte) (imageIndex, error) {
	var index imageIndex
	if err := json.Unmarshal(value, &index); err != nil || index.SchemaVersion != 2 ||
		index.MediaType != OCIIndexMediaType || len(index.Manifests) == 0 {
		return imageIndex{}, fmt.Errorf("OCI image index is invalid")
	}
	return index, nil
}

func decodeManifest(value []byte) (imageManifest, error) {
	var manifest imageManifest
	if err := json.Unmarshal(value, &manifest); err != nil || manifest.SchemaVersion != 2 ||
		manifest.MediaType != OCIManifestMediaType || manifest.Config.Digest == "" {
		return imageManifest{}, fmt.Errorf("OCI image manifest is invalid")
	}
	return manifest, nil
}

func decodeDockerManifest(value []byte) ([]dockerManifestItem, error) {
	var manifest []dockerManifestItem
	if err := decodeStrict(value, &manifest); err != nil {
		return nil, fmt.Errorf("Docker manifest.json is invalid: %w", err)
	}
	if manifest == nil {
		return nil, fmt.Errorf("Docker manifest.json is invalid")
	}
	return manifest, nil
}

func descriptorBytes(scan archiveScan, value descriptor) ([]byte, error) {
	if err := validateDescriptor(scan, value); err != nil {
		return nil, err
	}
	name := "blobs/sha256/" + strings.TrimPrefix(value.Digest, "sha256:")
	bytes, found := scan.SmallFiles[name]
	if !found {
		return nil, fmt.Errorf("OCI descriptor %s is too large to inspect", value.Digest)
	}
	return bytes, nil
}

func validateDescriptor(scan archiveScan, value descriptor) error {
	if !sha256Pattern.MatchString(value.Digest) || value.Size < 0 {
		return fmt.Errorf("OCI descriptor is invalid")
	}
	name := "blobs/sha256/" + strings.TrimPrefix(value.Digest, "sha256:")
	if scan.Sizes[name] != value.Size {
		return fmt.Errorf("OCI descriptor %s size does not match its blob", value.Digest)
	}
	return nil
}

func validateTarPath(name string, directory bool) (string, error) {
	normalized := name
	if directory {
		normalized = strings.TrimSuffix(normalized, "/")
	}
	if normalized == "" || strings.Contains(normalized, "\\") || path.IsAbs(normalized) ||
		path.Clean(normalized) != normalized || normalized == "." || strings.HasPrefix(normalized, "../") {
		return "", fmt.Errorf("OCI archive contains unsafe path %q", name)
	}
	return normalized, nil
}

func validateRelativePath(value string) error {
	if value == "" || strings.Contains(value, "\\") || path.IsAbs(value) || path.Clean(value) != value ||
		value == "." || strings.HasPrefix(value, "../") {
		return fmt.Errorf("unsafe relative path %q", value)
	}
	return nil
}

func validateAttestationPath(value string) error {
	if err := validateRelativePath(value); err != nil || !strings.HasPrefix(value, "attestations/") {
		return fmt.Errorf("attestation path is unsafe")
	}
	return nil
}

func expectedRepository(role string) string {
	switch role {
	case ServerRole:
		return ServerRepository
	case CaddyRole:
		return CaddyRepository
	default:
		return ""
	}
}

func dockerBlobPath(digest string) string {
	return "blobs/sha256/" + strings.TrimPrefix(digest, "sha256:")
}

func equalStrings(left, right []string) bool {
	if len(left) != len(right) {
		return false
	}
	for index := range left {
		if left[index] != right[index] {
			return false
		}
	}
	return true
}

func roleOrder(role string) int {
	if role == ServerRole {
		return 0
	}
	return 1
}

func digestBytes(value []byte) string {
	digest := sha256.Sum256(value)
	return hex.EncodeToString(digest[:])
}

func digestFile(filename string) (string, error) {
	file, err := os.Open(filename)
	if err != nil {
		return "", err
	}
	defer file.Close()
	digest := sha256.New()
	if _, err := io.Copy(digest, file); err != nil {
		return "", err
	}
	return hex.EncodeToString(digest.Sum(nil)), nil
}

func writeTarDirectory(writer *tar.Writer, name string) error {
	return writer.WriteHeader(&tar.Header{Name: name, Mode: 0o755, Typeflag: tar.TypeDir})
}

func writeTarFile(writer *tar.Writer, name string, value []byte) error {
	if err := writer.WriteHeader(&tar.Header{Name: name, Mode: 0o644, Size: int64(len(value)), Typeflag: tar.TypeReg}); err != nil {
		return err
	}
	_, err := writer.Write(value)
	return err
}

func writeJSONAtomic(filename string, value any, mode fs.FileMode) error {
	encoded, err := json.MarshalIndent(value, "", "  ")
	if err != nil {
		return err
	}
	encoded = append(encoded, '\n')
	if err := os.MkdirAll(filepath.Dir(filename), 0o755); err != nil {
		return err
	}
	temporary, err := os.CreateTemp(filepath.Dir(filename), ".metadata-*.tmp")
	if err != nil {
		return err
	}
	name := temporary.Name()
	defer os.Remove(name)
	if err := temporary.Chmod(mode); err != nil {
		_ = temporary.Close()
		return err
	}
	if _, err := temporary.Write(encoded); err != nil {
		_ = temporary.Close()
		return err
	}
	if err := temporary.Sync(); err != nil {
		_ = temporary.Close()
		return err
	}
	if err := temporary.Close(); err != nil {
		return err
	}
	return os.Rename(name, filename)
}

func decodeStrict(value []byte, destination any) error {
	decoder := json.NewDecoder(bytes.NewReader(value))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(destination); err != nil {
		return err
	}
	if err := decoder.Decode(&struct{}{}); !errors.Is(err, io.EOF) {
		return fmt.Errorf("JSON contains trailing content")
	}
	return nil
}
