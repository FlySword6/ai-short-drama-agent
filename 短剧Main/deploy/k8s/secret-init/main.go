// secret-init fetches the environment runtime secret with the VKE IRSA OIDC
// identity. It deliberately writes shell exports only to the requested
// in-memory volume.
package main

import (
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"net"
	"net/url"
	"os"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"time"

	"github.com/volcengine/volcengine-go-sdk/service/kms"
	"github.com/volcengine/volcengine-go-sdk/volcengine"
	"github.com/volcengine/volcengine-go-sdk/volcengine/credentials"
	"github.com/volcengine/volcengine-go-sdk/volcengine/session"
)

// secretNamePattern is the fail-closed allowlist for KMS secret names: one
// secret per environment runtime, for example shortdrama/test/runtime. The
// retired shortdrama/production name does not match and is always rejected.
var secretNamePattern = regexp.MustCompile(`^shortdrama/(dev|test|prod)/[a-z-]+$`)

// The SDK adds 60 seconds to this value in AssumeRoleWithOIDC. Keep the
// resulting request below the IAM role's maximum session duration.
const oidcSessionDurationSeconds = 900

var secretKeys = []string{
	"ARK_API_KEY",
	"TOS_ACCESS_KEY",
	"TOS_SECRET_KEY",
	"POSTGRES_PASSWORD",
	"MILVUS_PASSWORD",
}

// vnextRuntimeSecretKeys are direct KMS values for the isolated vNext runtime.
// VNEXT_DATABASE_URL is deliberately not synthesized from POSTGRES_* fields:
// the vNext runtime uses its own NOINHERIT database login.
var vnextRuntimeSecretKeys = []string{
	"VNEXT_DATABASE_URL",
	"VNEXT_STORYBOARD_IMAGE_API_KEY",
}

// migratorSecretKeys are direct KMS values for the short-lived DDL Job. The
// migrator has a distinct login and must never inherit the runtime password.
var migratorSecretKeys = []string{"DATABASE_URL"}

// optionalRegistrationSecretKeys are deliberately not part of the five
// launch-required values above. They are only materialized when the complete
// AK/SK pair is present in KMS, so existing runtime releases keep their
// exact startup contract while Seedance trusted-asset registration stays off
// by default.
var optionalRegistrationSecretKeys = []string{
	"VOLCENGINE_ACCESS_KEY_ID",
	"VOLCENGINE_SECRET_ACCESS_KEY",
	"VOLCENGINE_SECURITY_TOKEN",
}

// optionalProviderSecretKeys stay outside the launch-required set so releases
// without the corresponding provider or integration remain startup-compatible.
// A key alone does not enable a capability: its non-secret configuration must
// also be configured explicitly. When present, each value is validated and
// exported.
var optionalProviderSecretKeys = []string{
	"SEED_AUDIO_API_KEY",
	"MINIMAX_API_KEY",
	"NEWAPI_API_KEY",
	"COL_BASE_URL",
	"COL_APIKEY",
	"WECOM_CORP_SECRET",
}

type config struct {
	secretName string
	region     string
	output     string
}

type secretClient interface {
	GetSecretValue(*kms.GetSecretValueInput) (*kms.GetSecretValueOutput, error)
}

func main() {
	if err := run(os.Args[1:], os.Getenv, fetchSecret); err != nil {
		// Do not include API responses, environment values, or secret values here.
		fmt.Fprintln(os.Stderr, "secret-init:", err)
		os.Exit(1)
	}
}

func run(args []string, getenv func(string) string, fetch func(string, string) (string, error)) error {
	cfg, err := parseFlags(args)
	if err != nil {
		return err
	}

	raw, err := fetch(cfg.region, cfg.secretName)
	if err != nil {
		return fmt.Errorf("could not retrieve KMS secret: %w", err)
	}

	values := make(map[string]string)
	if err := json.Unmarshal([]byte(raw), &values); err != nil {
		return errors.New("KMS secret is not a JSON object")
	}
	if isMigratorSecret(cfg.secretName) {
		if err := validateMigratorSecretValues(values); err != nil {
			return err
		}
		return writeExports(cfg.output, values, migratorSecretKeys)
	}
	if isVnextRuntimeSecret(cfg.secretName) {
		if err := validateVnextRuntimeSecretValues(values); err != nil {
			return err
		}
		return writeExports(cfg.output, values, vnextRuntimeSecretKeys)
	}
	if err := validateSecretValues(values); err != nil {
		return err
	}

	databaseURL, err := databaseURLFromEnv(getenv, values["POSTGRES_PASSWORD"])
	if err != nil {
		return err
	}
	values["DATABASE_URL"] = databaseURL
	return writeExports(cfg.output, values, exportKeys(values))
}

func parseFlags(args []string) (config, error) {
	fs := flag.NewFlagSet("secret-init", flag.ContinueOnError)
	fs.SetOutput(os.Stderr)
	secretName := fs.String("secret-name", "", "KMS secret name, must match shortdrama/(dev|test|prod)/<name>")
	region := fs.String("region", "", "Volcengine region")
	output := fs.String("output", "", "output shell file")
	if err := fs.Parse(args); err != nil {
		return config{}, err
	}
	if !secretNamePattern.MatchString(*secretName) {
		return config{}, fmt.Errorf("secret name %q is not in the shortdrama/(dev|test|prod)/<name> allowlist", *secretName)
	}
	if *region == "" || *output == "" {
		return config{}, errors.New("--region and --output are required")
	}
	return config{secretName: *secretName, region: *region, output: *output}, nil
}

func newOIDCCredentialsProvider(getenv func(string) string) *credentials.OIDCCredentialsProvider {
	return credentials.NewOIDCCredentialsProviderWithOptions(
		getenv("VOLCENGINE_OIDC_TOKEN_FILE"),
		getenv("VOLCENGINE_OIDC_ROLE_TRN"),
		func(options *credentials.OIDCProviderOptions) {
			sessionName := getenv("VOLCENGINE_OIDC_ROLE_SESSION_NAME")
			if sessionName == "" {
				sessionName = "shortdrama-secret-init-" + strconv.FormatInt(time.Now().UnixNano()/1000, 10)
			}
			options.RoleSessionName = sessionName
			options.Policy = getenv("VOLCENGINE_OIDC_ROLE_POLICY")
			options.Endpoint = getenv("VOLCENGINE_OIDC_STS_ENDPOINT")
			options.DurationSeconds = oidcSessionDurationSeconds
		},
	)
}

func fetchSecret(region, secretName string) (string, error) {
	provider := newOIDCCredentialsProvider(os.Getenv)
	sess, err := session.NewSession(volcengine.NewConfig().
		WithCredentials(credentials.NewCredentials(provider)).
		WithRegion(region))
	if err != nil {
		return "", fmt.Errorf("create session: %w", err)
	}
	response, err := kms.New(sess).GetSecretValue(&kms.GetSecretValueInput{SecretName: volcengine.String(secretName)})
	if err != nil {
		return "", fmt.Errorf("GetSecretValue failed: %w", err)
	}
	if response == nil || response.SecretValue == nil {
		return "", errors.New("GetSecretValue returned empty response")
	}
	return *response.SecretValue, nil
}

func validateSecretValues(values map[string]string) error {
	for _, key := range secretKeys {
		value, ok := values[key]
		if !ok || !safeValue(value) {
			return fmt.Errorf("KMS secret has invalid %s", key)
		}
	}
	if err := validateOptionalRegistrationSecrets(values); err != nil {
		return err
	}
	return validateOptionalProviderSecrets(values)
}

func isVnextRuntimeSecret(secretName string) bool {
	return strings.HasSuffix(secretName, "/vnext-runtime")
}

func isMigratorSecret(secretName string) bool {
	return strings.HasSuffix(secretName, "/migrator")
}

func validateMigratorSecretValues(values map[string]string) error {
	raw, ok := values["DATABASE_URL"]
	if !ok || !safeValue(raw) {
		return errors.New("KMS secret has invalid DATABASE_URL")
	}
	databaseURL, err := url.Parse(raw)
	if err != nil || databaseURL.Scheme != "postgresql" || databaseURL.Hostname() == "" ||
		databaseURL.Path == "" || databaseURL.Path == "/" || databaseURL.User == nil {
		return errors.New("KMS secret has invalid DATABASE_URL")
	}
	username := databaseURL.User.Username()
	password, hasPassword := databaseURL.User.Password()
	if username != "shortdrama_migrator" || !hasPassword || !safeValue(password) {
		return errors.New("KMS secret has invalid DATABASE_URL")
	}
	query, err := url.ParseQuery(databaseURL.RawQuery)
	if err != nil {
		return errors.New("KMS secret has invalid DATABASE_URL")
	}
	if len(query) != 2 || len(query["sslmode"]) != 1 || len(query["sslrootcert"]) != 1 {
		return errors.New("KMS secret has invalid DATABASE_URL")
	}
	rootCert := query["sslrootcert"][0]
	if query["sslmode"][0] != "verify-full" || !filepath.IsAbs(rootCert) {
		return errors.New("KMS secret has invalid DATABASE_URL")
	}
	port := databaseURL.Port()
	if port == "" {
		port = "5432"
	}
	if err := validateDatabaseEndpoint(databaseURL.Hostname(), port, rootCert); err != nil {
		return errors.New("KMS secret has invalid DATABASE_URL")
	}
	return nil
}

func validateVnextRuntimeSecretValues(values map[string]string) error {
	databaseURL, hasDatabaseURL := values["VNEXT_DATABASE_URL"]
	imageAPIKey, hasImageAPIKey := values["VNEXT_STORYBOARD_IMAGE_API_KEY"]
	if !hasDatabaseURL || !hasImageAPIKey {
		return errors.New("KMS secret must provide both VNEXT_DATABASE_URL and VNEXT_STORYBOARD_IMAGE_API_KEY")
	}
	if !safeValue(databaseURL) {
		return errors.New("KMS secret has invalid VNEXT_DATABASE_URL")
	}
	if !safeValue(imageAPIKey) {
		return errors.New("KMS secret has invalid VNEXT_STORYBOARD_IMAGE_API_KEY")
	}
	return nil
}

func validateOptionalProviderSecrets(values map[string]string) error {
	_, hasColBaseURL := values["COL_BASE_URL"]
	_, hasColAPIKey := values["COL_APIKEY"]
	if hasColBaseURL != hasColAPIKey {
		return errors.New("KMS secret must provide both COL_BASE_URL and COL_APIKEY")
	}
	for _, key := range optionalProviderSecretKeys {
		value, ok := values[key]
		if ok && !safeValue(value) {
			return fmt.Errorf("KMS secret has invalid %s", key)
		}
	}
	return nil
}

func validateOptionalRegistrationSecrets(values map[string]string) error {
	accessKey, hasAccessKey := values["VOLCENGINE_ACCESS_KEY_ID"]
	secretKey, hasSecretKey := values["VOLCENGINE_SECRET_ACCESS_KEY"]
	securityToken, hasSecurityToken := values["VOLCENGINE_SECURITY_TOKEN"]

	if !hasAccessKey && !hasSecretKey && !hasSecurityToken {
		return nil
	}
	if !hasAccessKey || !hasSecretKey {
		return errors.New("KMS secret must provide both VOLCENGINE_ACCESS_KEY_ID and VOLCENGINE_SECRET_ACCESS_KEY")
	}
	if !safeValue(accessKey) {
		return errors.New("KMS secret has invalid VOLCENGINE_ACCESS_KEY_ID")
	}
	if !safeValue(secretKey) {
		return errors.New("KMS secret has invalid VOLCENGINE_SECRET_ACCESS_KEY")
	}
	if hasSecurityToken && !safeValue(securityToken) {
		return errors.New("KMS secret has invalid VOLCENGINE_SECURITY_TOKEN")
	}
	return nil
}

func databaseURLFromEnv(getenv func(string) string, password string) (string, error) {
	if !safeValue(password) {
		return "", errors.New("KMS secret has invalid POSTGRES_PASSWORD")
	}
	host := getenv("POSTGRES_HOST")
	port := getenv("POSTGRES_PORT")
	database := getenv("POSTGRES_DB")
	user := getenv("POSTGRES_USER")
	rootCert := getenv("POSTGRES_SSL_ROOT_CERT")
	for key, value := range map[string]string{
		"POSTGRES_HOST":          host,
		"POSTGRES_PORT":          port,
		"POSTGRES_DB":            database,
		"POSTGRES_USER":          user,
		"POSTGRES_SSL_ROOT_CERT": rootCert,
	} {
		if !safeValue(value) {
			return "", fmt.Errorf("missing or unsafe %s", key)
		}
	}
	if getenv("POSTGRES_SSL_MODE") != "verify-full" {
		return "", errors.New("POSTGRES_SSL_MODE must be verify-full")
	}
	if err := validateDatabaseEndpoint(host, port, rootCert); err != nil {
		return "", err
	}

	u := &url.URL{
		Scheme: "postgresql",
		User:   url.UserPassword(user, password),
		Host:   net.JoinHostPort(host, port),
		Path:   database,
	}
	query := u.Query()
	query.Set("uselibpqcompat", "true")
	query.Set("sslmode", "verify-full")
	query.Set("sslrootcert", rootCert)
	u.RawQuery = query.Encode()
	return u.String(), nil
}

func validateDatabaseEndpoint(host, port, rootCert string) error {
	normalizedHost := strings.ToLower(strings.TrimSuffix(host, "."))
	if normalizedHost == "localhost" || strings.HasSuffix(normalizedHost, ".localhost") ||
		normalizedHost == "0.0.0.0" || strings.HasSuffix(normalizedHost, ".invalid") {
		return errors.New("POSTGRES_HOST must be a remote RDS endpoint")
	}
	if ip := net.ParseIP(normalizedHost); ip != nil && ip.IsLoopback() {
		return errors.New("POSTGRES_HOST must not be loopback")
	}
	portNumber, err := strconv.Atoi(port)
	if err != nil || portNumber < 1 || portNumber > 65535 {
		return errors.New("POSTGRES_PORT must be between 1 and 65535")
	}
	if !filepath.IsAbs(rootCert) {
		return errors.New("POSTGRES_SSL_ROOT_CERT must be an absolute path")
	}
	return nil
}

func safeValue(value string) bool {
	return value != "" && !strings.ContainsAny(value, "\r\n\x00")
}

func bashQuote(value string) string {
	return "'" + strings.ReplaceAll(value, "'", "'\"'\"'") + "'"
}

func writeExports(output string, values map[string]string, keys []string) error {
	var content strings.Builder
	content.WriteString("# Generated by shortdrama secret-init. Do not edit.\n")
	for _, key := range keys {
		content.WriteString("export ")
		content.WriteString(key)
		content.WriteByte('=')
		content.WriteString(bashQuote(values[key]))
		content.WriteByte('\n')
	}

	dir := filepath.Dir(output)
	file, err := os.CreateTemp(dir, ".production-secrets-*")
	if err != nil {
		return fmt.Errorf("create output: %w", err)
	}
	temporary := file.Name()
	defer os.Remove(temporary)
	if err := file.Chmod(0o600); err != nil {
		file.Close()
		return fmt.Errorf("set output permissions: %w", err)
	}
	if _, err := file.WriteString(content.String()); err != nil {
		file.Close()
		return fmt.Errorf("write output: %w", err)
	}
	if err := file.Sync(); err != nil {
		file.Close()
		return fmt.Errorf("sync output: %w", err)
	}
	if err := file.Close(); err != nil {
		return fmt.Errorf("close output: %w", err)
	}
	if err := os.Rename(temporary, output); err != nil {
		return fmt.Errorf("publish output: %w", err)
	}
	return os.Chmod(output, 0o600)
}

func exportKeys(values map[string]string) []string {
	keys := append([]string{}, secretKeys...)
	if _, hasAccessKey := values[optionalRegistrationSecretKeys[0]]; hasAccessKey {
		keys = append(keys, optionalRegistrationSecretKeys[:2]...)
		if _, hasSecurityToken := values[optionalRegistrationSecretKeys[2]]; hasSecurityToken {
			keys = append(keys, optionalRegistrationSecretKeys[2])
		}
	}
	for _, key := range optionalProviderSecretKeys {
		if _, ok := values[key]; ok {
			keys = append(keys, key)
		}
	}
	return append(keys, "DATABASE_URL")
}
