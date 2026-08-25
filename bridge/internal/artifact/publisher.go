package artifact

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"sort"
	"strings"

	"agentroom.dev/bridge/internal/config"
	"agentroom.dev/bridge/internal/pairing"
)

const chunkBytes = 256 << 10

type PublishInput struct {
	RunID        string
	AgentID      string
	ArtifactType string
	Title        string
	Summary      string
	Source       SourcePlan
	Relations    []PublishRelation
}

type PublishRelation struct {
	Type             string `json:"type"`
	TargetArtifactID string `json:"targetArtifactId"`
}

type PublishResult struct {
	PublicationID string
	ArtifactID    string
	ContentID     string
	Revision      int64
	SHA256        string
}

type Client struct {
	config     config.Config
	credential pairing.Credential
	httpClient *http.Client
}

type publicationView struct {
	PublicationID string  `json:"publicationId"`
	ReceivedSize  int     `json:"receivedSize"`
	State         string  `json:"state"`
	ContentID     *string `json:"contentId"`
	ArtifactID    *string `json:"artifactId"`
}

type leaseView struct {
	LeaseID string `json:"leaseId"`
	State   string `json:"state"`
}

type sealView struct {
	Publication publicationView `json:"publication"`
	Content     struct {
		ContentID string `json:"contentId"`
	} `json:"content"`
}

type bindView struct {
	Revision int64 `json:"revision"`
	Artifact struct {
		ArtifactID string  `json:"artifactId"`
		ContentID  *string `json:"contentId"`
	} `json:"artifact"`
}

type outcomeUnknownError struct{ cause error }

func (e outcomeUnknownError) Error() string {
	return "Artifact publication outcome is unknown: " + e.cause.Error()
}

func NewClient(cfg config.Config, credential pairing.Credential) *Client {
	return &Client{
		config: cfg, credential: credential, httpClient: pairing.HTTPClient(cfg),
	}
}

func (c *Client) Publish(
	ctx context.Context,
	input PublishInput,
) (PublishResult, error) {
	if input.RunID == "" || input.AgentID == "" || input.Title == "" || input.Summary == "" {
		return PublishResult{}, fmt.Errorf("Artifact publication identity and description are required")
	}
	if len(input.Title) > 160 || len(input.Summary) > 4_000 {
		return PublishResult{}, fmt.Errorf("Artifact title or summary exceeds its bound")
	}
	if err := validateSourcePlan(input.Source, input.ArtifactType); err != nil {
		return PublishResult{}, err
	}
	relations, err := normalizedPublishRelations(input.Relations)
	if err != nil {
		return PublishResult{}, err
	}
	leaseKey := leaseIdempotencyKey(input, relations)
	leaseRequest := map[string]any{
		"runId": input.RunID, "agentId": input.AgentID,
		"workspaceRef":        input.Source.WorkspaceRef,
		"workspaceGeneration": input.Source.WorkspaceGeneration,
		"idempotencyKey":      leaseKey,
		"durationSeconds":     300,
	}
	var lease leaseView
	if err := c.retrySameRequest(
		ctx, http.MethodPost, "/api/bridge/workspace-leases/read-source",
		leaseRequest, &lease,
	); err != nil {
		return PublishResult{}, err
	}
	if lease.LeaseID == "" || lease.State != "active" {
		return PublishResult{}, fmt.Errorf("Workspace source lease is not active")
	}
	source, err := Capture(input.Source)
	if err != nil {
		return PublishResult{}, err
	}
	if err := validateSource(source, input.ArtifactType); err != nil {
		return PublishResult{}, err
	}
	publicationKey := idempotencyKey(
		"publication", input.RunID, input.AgentID,
		source.WorkspaceRef, source.WorkspaceGeneration,
		input.ArtifactType, source.FileName, source.SHA256,
		input.Title, input.Summary,
		publishRelationsIdentity(relations),
	)
	prepareRequest := map[string]any{
		"leaseId": lease.LeaseID, "runId": input.RunID,
		"agentId":             input.AgentID,
		"workspaceRef":        source.WorkspaceRef,
		"workspaceGeneration": source.WorkspaceGeneration,
		"idempotencyKey":      publicationKey,
		"artifactType":        input.ArtifactType,
		"fileName":            source.FileName,
		"mediaType":           source.MediaType,
		"title":               input.Title, "summary": input.Summary,
		"sizeBytes": len(source.Bytes), "sha256": source.SHA256,
	}
	if len(relations) > 0 {
		prepareRequest["relations"] = relations
	}
	var publication publicationView
	if err := c.retrySameRequest(
		ctx, http.MethodPost, "/api/bridge/artifact-publications",
		prepareRequest, &publication,
	); err != nil {
		return PublishResult{}, err
	}
	if publication.PublicationID == "" {
		return PublishResult{}, fmt.Errorf("Artifact prepare response omitted publication identity")
	}
	for publication.State == "prepared" || publication.State == "receiving" {
		if publication.ReceivedSize < 0 || publication.ReceivedSize > len(source.Bytes) {
			return PublishResult{}, fmt.Errorf("Server reported an invalid Artifact upload offset")
		}
		if publication.ReceivedSize == len(source.Bytes) {
			break
		}
		end := min(publication.ReceivedSize+chunkBytes, len(source.Bytes))
		chunk := source.Bytes[publication.ReceivedSize:end]
		digest := sha256.Sum256(chunk)
		chunkRequest := map[string]any{
			"offset":      publication.ReceivedSize,
			"chunkBase64": base64.StdEncoding.EncodeToString(chunk),
			"chunkSha256": hex.EncodeToString(digest[:]),
		}
		before := publication.ReceivedSize
		err := c.request(
			ctx, http.MethodPost,
			"/api/bridge/artifact-publications/"+publication.PublicationID+"/chunks",
			chunkRequest, &publication,
		)
		if err == nil {
			continue
		}
		if !isOutcomeUnknown(err) {
			return PublishResult{}, err
		}
		if statusErr := c.status(ctx, publication.PublicationID, &publication); statusErr != nil {
			return PublishResult{}, err
		}
		if publication.ReceivedSize == before {
			if retryErr := c.request(
				ctx, http.MethodPost,
				"/api/bridge/artifact-publications/"+publication.PublicationID+"/chunks",
				chunkRequest, &publication,
			); retryErr != nil {
				return PublishResult{}, retryErr
			}
		}
	}
	if publication.State == "failed" || publication.State == "expired" {
		return PublishResult{}, fmt.Errorf("Artifact publication is %s", publication.State)
	}
	contentID := valueOrEmpty(publication.ContentID)
	if publication.State == "prepared" || publication.State == "receiving" {
		var sealed sealView
		err := c.request(
			ctx, http.MethodPost,
			"/api/bridge/artifact-publications/"+publication.PublicationID+"/seal",
			map[string]any{}, &sealed,
		)
		if err != nil && isOutcomeUnknown(err) {
			if statusErr := c.status(ctx, publication.PublicationID, &publication); statusErr != nil {
				return PublishResult{}, err
			}
			if publication.State == "prepared" || publication.State == "receiving" {
				err = c.request(
					ctx, http.MethodPost,
					"/api/bridge/artifact-publications/"+publication.PublicationID+"/seal",
					map[string]any{}, &sealed,
				)
			}
		}
		if err != nil && (publication.State == "prepared" || publication.State == "receiving") {
			return PublishResult{}, err
		}
		if sealed.Publication.PublicationID != "" {
			publication = sealed.Publication
			contentID = sealed.Content.ContentID
		} else {
			contentID = valueOrEmpty(publication.ContentID)
		}
	}
	if publication.State == "bound" && publication.ArtifactID != nil {
		return PublishResult{
			PublicationID: publication.PublicationID,
			ArtifactID:    *publication.ArtifactID,
			ContentID:     contentID,
			SHA256:        source.SHA256,
		}, nil
	}
	var bound bindView
	err = c.request(
		ctx, http.MethodPost,
		"/api/bridge/artifact-publications/"+publication.PublicationID+"/bind",
		map[string]any{}, &bound,
	)
	if err != nil && isOutcomeUnknown(err) {
		if statusErr := c.status(ctx, publication.PublicationID, &publication); statusErr == nil &&
			publication.State == "bound" && publication.ArtifactID != nil {
			return PublishResult{
				PublicationID: publication.PublicationID,
				ArtifactID:    *publication.ArtifactID,
				ContentID:     valueOrEmpty(publication.ContentID),
				SHA256:        source.SHA256,
			}, nil
		}
	}
	if err != nil {
		return PublishResult{}, err
	}
	return PublishResult{
		PublicationID: publication.PublicationID,
		ArtifactID:    bound.Artifact.ArtifactID,
		ContentID:     valueOrEmpty(bound.Artifact.ContentID),
		Revision:      bound.Revision,
		SHA256:        source.SHA256,
	}, nil
}

func normalizedPublishRelations(
	input []PublishRelation,
) ([]PublishRelation, error) {
	if len(input) > 20 {
		return nil, fmt.Errorf("Artifact publication supports at most 20 relations")
	}
	relations := append([]PublishRelation(nil), input...)
	sort.Slice(relations, func(left, right int) bool {
		if relations[left].TargetArtifactID == relations[right].TargetArtifactID {
			return relations[left].Type < relations[right].Type
		}
		return relations[left].TargetArtifactID < relations[right].TargetArtifactID
	})
	identities := make(map[string]bool, len(relations))
	for _, relation := range relations {
		if (relation.Type != "derives_from" && relation.Type != "reviews" &&
			relation.Type != "verifies") ||
			!validPublicationArtifactID(relation.TargetArtifactID) {
			return nil, fmt.Errorf("Artifact publication relation is invalid")
		}
		identity := relation.TargetArtifactID + "\x00" + relation.Type
		if identities[identity] {
			return nil, fmt.Errorf("Artifact publication relations must be unique")
		}
		identities[identity] = true
	}
	return relations, nil
}

func validPublicationArtifactID(value string) bool {
	if !strings.HasPrefix(value, "artifact_") {
		return false
	}
	suffix := strings.TrimPrefix(value, "artifact_")
	if len(suffix) < 8 || len(suffix) > 128 {
		return false
	}
	for _, character := range suffix {
		if (character < 'A' || character > 'Z') &&
			(character < 'a' || character > 'z') &&
			(character < '0' || character > '9') && character != '_' && character != '-' {
			return false
		}
	}
	return true
}

func publishRelationsIdentity(relations []PublishRelation) string {
	parts := make([]string, 0, len(relations))
	for _, relation := range relations {
		parts = append(parts, relation.Type+":"+relation.TargetArtifactID)
	}
	return strings.Join(parts, ",")
}

func leaseIdempotencyKey(
	input PublishInput,
	relations []PublishRelation,
) string {
	return idempotencyKey(
		"lease", input.RunID, input.AgentID, input.Source.leaseIdentity(),
		input.ArtifactType, input.Title, input.Summary,
		publishRelationsIdentity(relations),
	)
}

func (c *Client) retrySameRequest(
	ctx context.Context, method, requestPath string, input, output any,
) error {
	err := c.request(ctx, method, requestPath, input, output)
	if err != nil && isOutcomeUnknown(err) {
		return c.request(ctx, method, requestPath, input, output)
	}
	return err
}

func (c *Client) status(
	ctx context.Context, publicationID string, output *publicationView,
) error {
	return c.request(
		ctx, http.MethodGet,
		"/api/bridge/artifact-publications/"+publicationID, nil, output,
	)
}

func (c *Client) request(
	ctx context.Context, method, requestPath string, input, output any,
) error {
	var body io.Reader
	if input != nil {
		source, err := json.Marshal(input)
		if err != nil {
			return err
		}
		body = bytes.NewReader(source)
	}
	endpoint := strings.TrimRight(c.config.ServerURL, "/") + requestPath
	request, err := http.NewRequestWithContext(ctx, method, endpoint, body)
	if err != nil {
		return err
	}
	request.Header.Set("authorization", "Bearer "+c.credential.Token)
	if input != nil {
		request.Header.Set("content-type", "application/json")
	}
	if c.config.ServerToken != "" {
		request.Header.Set(config.ServerTokenHeader, c.config.ServerToken)
	}
	response, err := c.httpClient.Do(request)
	if err != nil {
		return outcomeUnknownError{cause: err}
	}
	defer response.Body.Close()
	source, err := io.ReadAll(io.LimitReader(response.Body, 1<<20))
	if err != nil {
		return outcomeUnknownError{cause: err}
	}
	if response.StatusCode < 200 || response.StatusCode >= 300 {
		var rejected struct {
			Error struct {
				Message string `json:"message"`
			} `json:"error"`
		}
		_ = json.Unmarshal(source, &rejected)
		message := strings.TrimSpace(rejected.Error.Message)
		if message == "" {
			message = http.StatusText(response.StatusCode)
		}
		return fmt.Errorf("Artifact API rejected request with status %d: %s", response.StatusCode, message)
	}
	if output == nil {
		return nil
	}
	if err := json.Unmarshal(source, output); err != nil {
		return outcomeUnknownError{cause: fmt.Errorf("decode Artifact API response: %w", err)}
	}
	return nil
}

func idempotencyKey(parts ...string) string {
	digest := sha256.New()
	for _, part := range parts {
		_, _ = digest.Write([]byte(part))
		_, _ = digest.Write([]byte{0})
	}
	return "idem_" + hex.EncodeToString(digest.Sum(nil))
}

func isOutcomeUnknown(err error) bool {
	_, ok := err.(outcomeUnknownError)
	return ok
}

func valueOrEmpty(value *string) string {
	if value == nil {
		return ""
	}
	return *value
}

func validateSource(source Source, artifactType string) error {
	if len(source.Bytes) < 1 || len(source.Bytes) > MaximumSourceBytes ||
		!strings.HasPrefix(source.WorkspaceRef, "workspace_") ||
		len(source.WorkspaceRef) != len("workspace_")+64 ||
		!validLowerHex(strings.TrimPrefix(source.WorkspaceRef, "workspace_"), 64) ||
		!validLowerHex(source.WorkspaceGeneration, 64) ||
		strings.ContainsAny(source.FileName, "/\\") {
		return fmt.Errorf("Artifact source snapshot is invalid")
	}
	mediaType, err := mediaTypeFor(artifactType, source.FileName)
	if err != nil || mediaType != source.MediaType {
		return fmt.Errorf("Artifact source type or media type is invalid")
	}
	digest := sha256.Sum256(source.Bytes)
	if hex.EncodeToString(digest[:]) != source.SHA256 {
		return fmt.Errorf("Artifact source digest is invalid")
	}
	return nil
}

func validLowerHex(value string, length int) bool {
	if len(value) != length || value != strings.ToLower(value) {
		return false
	}
	_, err := hex.DecodeString(value)
	return err == nil
}
