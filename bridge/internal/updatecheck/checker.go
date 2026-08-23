package updatecheck

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"regexp"
	"strconv"
	"strings"
	"time"
)

const (
	LatestReleaseAPI = "https://api.github.com/repos/chenrgSix/AgentRoom/releases/latest"
	maxResponseBytes = 64 * 1024
)

type Result struct {
	CurrentVersion    string `json:"currentVersion"`
	LatestVersion     string `json:"latestVersion"`
	CurrentComparable bool   `json:"currentComparable"`
	CurrentPrerelease bool   `json:"currentPrerelease"`
	UpdateAvailable   bool   `json:"updateAvailable"`
	PublishedAt       string `json:"publishedAt,omitempty"`
	ReleaseURL        string `json:"releaseUrl"`
	CheckedAt         string `json:"checkedAt"`
}

type Service interface {
	Check(context.Context, string) (Result, error)
}

type Checker struct {
	Client   *http.Client
	Endpoint string
	Now      func() time.Time
}

func New() *Checker {
	return &Checker{
		Client:   &http.Client{Timeout: 5 * time.Second},
		Endpoint: LatestReleaseAPI,
	}
}

func (c *Checker) Check(ctx context.Context, currentVersion string) (Result, error) {
	endpoint := c.Endpoint
	if endpoint == "" {
		endpoint = LatestReleaseAPI
	}
	client := c.Client
	if client == nil {
		client = &http.Client{Timeout: 5 * time.Second}
	}
	request, err := http.NewRequestWithContext(ctx, http.MethodGet, endpoint, nil)
	if err != nil {
		return Result{}, err
	}
	request.Header.Set("accept", "application/vnd.github+json")
	request.Header.Set("user-agent", "AgentRoom-Bridge")
	response, err := client.Do(request)
	if err != nil {
		return Result{}, fmt.Errorf("check latest Bridge release: %w", err)
	}
	defer response.Body.Close()
	if response.StatusCode != http.StatusOK {
		return Result{}, fmt.Errorf("GitHub release check returned status %d", response.StatusCode)
	}
	source, err := io.ReadAll(io.LimitReader(response.Body, maxResponseBytes+1))
	if err != nil {
		return Result{}, err
	}
	if len(source) > maxResponseBytes {
		return Result{}, fmt.Errorf("GitHub release response exceeded %d bytes", maxResponseBytes)
	}
	var release struct {
		TagName     string `json:"tag_name"`
		HTMLURL     string `json:"html_url"`
		PublishedAt string `json:"published_at"`
	}
	decoder := json.NewDecoder(strings.NewReader(string(source)))
	if err := decoder.Decode(&release); err != nil {
		return Result{}, fmt.Errorf("decode GitHub release response: %w", err)
	}
	if err := decoder.Decode(&struct{}{}); err != io.EOF {
		return Result{}, fmt.Errorf("decode GitHub release response: trailing content")
	}
	latest, ok := parseVersion(release.TagName)
	if !ok {
		return Result{}, fmt.Errorf("latest Bridge release tag is not semantic versioning")
	}
	if err := validateReleaseURL(release.HTMLURL, release.TagName); err != nil {
		return Result{}, err
	}
	now := time.Now().UTC()
	if c.Now != nil {
		now = c.Now().UTC()
	}
	result := Result{
		CurrentVersion: strings.TrimSpace(currentVersion), LatestVersion: release.TagName,
		PublishedAt: release.PublishedAt, ReleaseURL: release.HTMLURL,
		CheckedAt: now.Format(time.RFC3339Nano),
	}
	current, comparable := parseVersion(currentVersion)
	result.CurrentComparable = comparable
	result.CurrentPrerelease = comparable && current.prerelease != ""
	result.UpdateAvailable = comparable && current.compare(latest) < 0
	return result, nil
}

type semanticVersion struct {
	major      int
	minor      int
	patch      int
	prerelease string
}

var semanticVersionPattern = regexp.MustCompile(`^v?([0-9]+)\.([0-9]+)\.([0-9]+)(?:-([0-9A-Za-z.-]+))?$`)

func parseVersion(value string) (semanticVersion, bool) {
	match := semanticVersionPattern.FindStringSubmatch(strings.TrimSpace(value))
	if match == nil {
		return semanticVersion{}, false
	}
	major, majorErr := strconv.Atoi(match[1])
	minor, minorErr := strconv.Atoi(match[2])
	patch, patchErr := strconv.Atoi(match[3])
	if majorErr != nil || minorErr != nil || patchErr != nil {
		return semanticVersion{}, false
	}
	return semanticVersion{major: major, minor: minor, patch: patch, prerelease: match[4]}, true
}

func (v semanticVersion) compare(other semanticVersion) int {
	for _, values := range [][2]int{{v.major, other.major}, {v.minor, other.minor}, {v.patch, other.patch}} {
		if values[0] < values[1] {
			return -1
		}
		if values[0] > values[1] {
			return 1
		}
	}
	if v.prerelease == other.prerelease {
		return 0
	}
	if v.prerelease != "" && other.prerelease == "" {
		return -1
	}
	if v.prerelease == "" {
		return 1
	}
	return strings.Compare(v.prerelease, other.prerelease)
}

func validateReleaseURL(value, releaseTag string) error {
	parsed, err := url.Parse(value)
	if err != nil || parsed.Scheme != "https" || parsed.Host != "github.com" || parsed.User != nil {
		return fmt.Errorf("GitHub release URL is not trusted")
	}
	if parsed.EscapedPath() != "/chenrgSix/AgentRoom/releases/tag/"+url.PathEscape(releaseTag) || parsed.RawQuery != "" || parsed.Fragment != "" {
		return fmt.Errorf("GitHub release URL is outside the AgentRoom repository")
	}
	return nil
}
