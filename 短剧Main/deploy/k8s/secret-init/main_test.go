package main

import (
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestBashQuote(t *testing.T) {
	got := bashQuote("a'b c")
	if got != "'a'\"'\"'b c'" {
		t.Fatalf("bashQuote() = %q", got)
	}
}

func TestOIDCProviderPreservesEnvironment(t *testing.T) {
	env := map[string]string{
		"VOLCENGINE_OIDC_TOKEN_FILE":        "/var/run/secrets/oidc/token",
		"VOLCENGINE_OIDC_ROLE_TRN":          "trn:iam::2100701382:role/shortdrama-prod-kms-reader",
		"VOLCENGINE_OIDC_ROLE_SESSION_NAME": "shortdrama-test",
		"VOLCENGINE_OIDC_ROLE_POLICY":       `{"Statement":[]}`,
		"VOLCENGINE_OIDC_STS_ENDPOINT":      "sts.example.internal",
	}

	provider := newOIDCCredentialsProvider(func(key string) string { return env[key] })

	if provider.DurationSeconds != 900 {
		t.Fatalf("DurationSeconds = %d, want 900", provider.DurationSeconds)
	}
	if provider.OIDCTokenFilePath != env["VOLCENGINE_OIDC_TOKEN_FILE"] {
		t.Fatalf("OIDCTokenFilePath = %q", provider.OIDCTokenFilePath)
	}
	if provider.RoleTrn != env["VOLCENGINE_OIDC_ROLE_TRN"] {
		t.Fatalf("RoleTrn = %q", provider.RoleTrn)
	}
	if provider.RoleSessionName != env["VOLCENGINE_OIDC_ROLE_SESSION_NAME"] {
		t.Fatalf("RoleSessionName = %q", provider.RoleSessionName)
	}
	if provider.Policy != env["VOLCENGINE_OIDC_ROLE_POLICY"] {
		t.Fatalf("Policy = %q", provider.Policy)
	}
	if provider.Endpoint != env["VOLCENGINE_OIDC_STS_ENDPOINT"] {
		t.Fatalf("Endpoint = %q", provider.Endpoint)
	}
}

func TestOIDCProviderRequestsBoundedSession(t *testing.T) {
	tokenFile := filepath.Join(t.TempDir(), "token")
	if err := os.WriteFile(tokenFile, []byte("test-oidc-token"), 0o600); err != nil {
		t.Fatal(err)
	}

	var duration string
	server := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		if err := request.ParseForm(); err != nil {
			t.Error(err)
			writer.WriteHeader(http.StatusBadRequest)
			return
		}
		duration = request.Form.Get("DurationSeconds")
		writer.Header().Set("Content-Type", "application/json")
		_, _ = writer.Write([]byte(`{"Result":{"Credentials":{"AccessKeyId":"test-ak","SecretAccessKey":"test-sk","SessionToken":"test-token","Expiration":"2125-01-01T00:00:00Z"}}}`))
	}))
	defer server.Close()

	env := map[string]string{
		"VOLCENGINE_OIDC_TOKEN_FILE": tokenFile,
		"VOLCENGINE_OIDC_ROLE_TRN":   "trn:iam::2100701382:role/shortdrama-prod-kms-reader",
	}
	provider := newOIDCCredentialsProvider(func(key string) string { return env[key] })
	provider.Schema = "http"
	provider.Endpoint = strings.TrimPrefix(server.URL, "http://")

	if _, err := provider.Retrieve(); err != nil {
		t.Fatal(err)
	}
	if duration != "960" {
		t.Fatalf("wire DurationSeconds = %q, want 960", duration)
	}
}

func TestOIDCProviderGeneratesSessionNameWhenUnset(t *testing.T) {
	provider := newOIDCCredentialsProvider(func(string) string { return "" })

	if !strings.HasPrefix(provider.RoleSessionName, "shortdrama-secret-init-") {
		t.Fatalf("RoleSessionName = %q", provider.RoleSessionName)
	}
}

func TestDatabaseURLFromEnvEscapesValues(t *testing.T) {
	env := map[string]string{
		"POSTGRES_HOST":          "db.internal",
		"POSTGRES_PORT":          "5432",
		"POSTGRES_DB":            "short drama",
		"POSTGRES_USER":          "app@example",
		"POSTGRES_SSL_MODE":      "verify-full",
		"POSTGRES_SSL_ROOT_CERT": "/etc/ssl/root cert.pem",
	}
	got, err := databaseURLFromEnv(func(key string) string { return env[key] }, "p@ss:/?word")
	if err != nil {
		t.Fatal(err)
	}
	u, err := url.Parse(got)
	if err != nil {
		t.Fatal(err)
	}
	if u.Scheme != "postgresql" || u.Host != "db.internal:5432" || u.Path != "/short drama" {
		t.Fatalf("unexpected URL shape: %s", got)
	}
	if u.User.Username() != "app@example" {
		t.Fatalf("username was not escaped correctly: %q", u.User.Username())
	}
	password, _ := u.User.Password()
	if password != "p@ss:/?word" {
		t.Fatalf("password was not escaped correctly: %q", password)
	}
	query := u.Query()
	if query.Get("uselibpqcompat") != "true" || query.Get("sslmode") != "verify-full" || query.Get("sslrootcert") != "/etc/ssl/root cert.pem" {
		t.Fatalf("unexpected URL query: %s", u.RawQuery)
	}
}

func TestDatabaseURLRejectsUnsafeEndpoint(t *testing.T) {
	for _, host := range []string{"localhost", "api.localhost", "127.0.0.1", "db.invalid"} {
		env := validEnv()
		env["POSTGRES_HOST"] = host
		if _, err := databaseURLFromEnv(func(key string) string { return env[key] }, "postgres"); err == nil {
			t.Fatalf("databaseURLFromEnv() accepted %q", host)
		}
	}
}

func TestRunRejectsMissingOrUnsafeSecrets(t *testing.T) {
	for _, value := range []string{"", "has\nnewline", "has\x00nul"} {
		values := validSecrets()
		values["ARK_API_KEY"] = value
		_, err := runForTest(t, values, validEnv())
		if err == nil || !strings.Contains(err.Error(), "ARK_API_KEY") {
			t.Fatalf("run() error = %v, want invalid ARK_API_KEY", err)
		}
	}
}

func TestRunWritesAtomicMode0600Exports(t *testing.T) {
	output, err := runForTest(t, validSecrets(), validEnv())
	if err != nil {
		t.Fatal(err)
	}
	info, err := os.Stat(output)
	if err != nil {
		t.Fatal(err)
	}
	if info.Mode().Perm() != 0o600 {
		t.Fatalf("mode = %o, want 600", info.Mode().Perm())
	}
	content, err := os.ReadFile(output)
	if err != nil {
		t.Fatal(err)
	}
	for _, key := range append(secretKeys, "DATABASE_URL") {
		if !strings.Contains(string(content), "export "+key+"=") {
			t.Fatalf("missing export for %s", key)
		}
	}
	for _, key := range []string{
		"VOLCENGINE_ACCESS_KEY_ID",
		"VOLCENGINE_SECRET_ACCESS_KEY",
		"VOLCENGINE_SECURITY_TOKEN",
		"SEED_AUDIO_API_KEY",
		"MINIMAX_API_KEY",
		"NEWAPI_API_KEY",
		"COL_BASE_URL",
		"COL_APIKEY",
		"WECOM_CORP_SECRET",
	} {
		if strings.Contains(string(content), "export "+key+"=") {
			t.Fatalf("optional credential %s was exported when absent", key)
		}
	}
}

func TestRunWritesVnextRuntimeExports(t *testing.T) {
	values := vnextRuntimeSecrets()
	values["VNEXT_STORYBOARD_IMAGE_API_KEY"] = "test-api'key"

	output, err := runVnextForTest(t, values)
	if err != nil {
		t.Fatal(err)
	}
	info, err := os.Stat(output)
	if err != nil {
		t.Fatal(err)
	}
	if info.Mode().Perm() != 0o600 {
		t.Fatalf("mode = %o, want 600", info.Mode().Perm())
	}
	content, err := os.ReadFile(output)
	if err != nil {
		t.Fatal(err)
	}
	want := "# Generated by shortdrama secret-init. Do not edit.\n" +
		"export VNEXT_DATABASE_URL='postgresql://vnext_runtime:test-password@db.internal:5432/shortdrama'\n" +
		"export VNEXT_STORYBOARD_IMAGE_API_KEY='test-api'\"'\"'key'\n"
	if string(content) != want {
		t.Fatalf("vNext exports = %q, want %q", content, want)
	}
}

func TestRunRejectsIncompleteVnextRuntimeSecrets(t *testing.T) {
	for name, remove := range map[string][]string{
		"database URL only":       {"VNEXT_STORYBOARD_IMAGE_API_KEY"},
		"storyboard API key only": {"VNEXT_DATABASE_URL"},
		"both values absent":      {"VNEXT_DATABASE_URL", "VNEXT_STORYBOARD_IMAGE_API_KEY"},
	} {
		t.Run(name, func(t *testing.T) {
			values := vnextRuntimeSecrets()
			for _, key := range remove {
				delete(values, key)
			}
			_, err := runVnextForTest(t, values)
			if err == nil || !strings.Contains(err.Error(), "VNEXT_DATABASE_URL and VNEXT_STORYBOARD_IMAGE_API_KEY") {
				t.Fatalf("run() error = %v, want complete vNext runtime pair", err)
			}
		})
	}
}

func TestRunRejectsUnsafeVnextRuntimeSecrets(t *testing.T) {
	for _, key := range vnextRuntimeSecretKeys {
		for _, value := range []string{"", "has\nnewline", "has\x00nul"} {
			t.Run(key, func(t *testing.T) {
				values := vnextRuntimeSecrets()
				values[key] = value
				_, err := runVnextForTest(t, values)
				if err == nil || !strings.Contains(err.Error(), key) {
					t.Fatalf("run() error = %v, want invalid %s", err, key)
				}
			})
		}
	}
}

func TestRunWritesMigratorDatabaseURL(t *testing.T) {
	const databaseURL = "postgresql://shortdrama_migrator:test-password@db.internal:5432/shortdrama?sslmode=verify-full&sslrootcert=%2Fetc%2Fssl%2Froot.pem"
	output, err := runMigratorForTest(t, map[string]string{"DATABASE_URL": databaseURL})
	if err != nil {
		t.Fatal(err)
	}
	content, err := os.ReadFile(output)
	if err != nil {
		t.Fatal(err)
	}
	want := "# Generated by shortdrama secret-init. Do not edit.\n" +
		"export DATABASE_URL='" + databaseURL + "'\n"
	if string(content) != want {
		t.Fatalf("migrator exports = %q, want %q", content, want)
	}
}

func TestRunRejectsInvalidMigratorDatabaseURL(t *testing.T) {
	for name, databaseURL := range map[string]string{
		"missing":          "",
		"wrong scheme":     "https://shortdrama_migrator:test-password@db.internal/shortdrama",
		"wrong user":       "postgresql://app:test-password@db.internal:5432/shortdrama?sslmode=verify-full&sslrootcert=%2Fetc%2Fssl%2Froot.pem",
		"missing password": "postgresql://shortdrama_migrator@db.internal:5432/shortdrama?sslmode=verify-full&sslrootcert=%2Fetc%2Fssl%2Froot.pem",
		"loopback host":    "postgresql://shortdrama_migrator:test-password@localhost:5432/shortdrama?sslmode=verify-full&sslrootcert=%2Fetc%2Fssl%2Froot.pem",
		"missing database": "postgresql://shortdrama_migrator:test-password@db.internal:5432/?sslmode=verify-full&sslrootcert=%2Fetc%2Fssl%2Froot.pem",
		"weak tls":         "postgresql://shortdrama_migrator:test-password@db.internal:5432/shortdrama?sslmode=disable&sslrootcert=%2Fetc%2Fssl%2Froot.pem",
		"relative CA":      "postgresql://shortdrama_migrator:test-password@db.internal:5432/shortdrama?sslmode=verify-full&sslrootcert=ca.pem",
		"duplicate tls":    "postgresql://shortdrama_migrator:test-password@db.internal:5432/shortdrama?sslmode=verify-full&sslmode=disable&sslrootcert=%2Fetc%2Fssl%2Froot.pem",
		"query override":   "postgresql://shortdrama_migrator:test-password@db.internal:5432/shortdrama?sslmode=verify-full&sslrootcert=%2Fetc%2Fssl%2Froot.pem&user=shortdrama_test",
		"malformed query":  "postgresql://shortdrama_migrator:test-password@db.internal:5432/shortdrama?sslmode=verify-full&sslrootcert=%2Fetc%2Fssl%2Froot.pem&options=%ZZ",
	} {
		t.Run(name, func(t *testing.T) {
			_, err := runMigratorForTest(t, map[string]string{"DATABASE_URL": databaseURL})
			if err == nil || !strings.Contains(err.Error(), "DATABASE_URL") {
				t.Fatalf("run() error = %v, want invalid DATABASE_URL", err)
			}
		})
	}
}

func TestRunKeepsRuntimeCompatibilityWhenVnextSecretsAreAbsent(t *testing.T) {
	output, err := runForTest(t, validSecrets(), validEnv())
	if err != nil {
		t.Fatal(err)
	}
	content, err := os.ReadFile(output)
	if err != nil {
		t.Fatal(err)
	}
	for _, key := range vnextRuntimeSecretKeys {
		if strings.Contains(string(content), "export "+key+"=") {
			t.Fatalf("regular runtime exported absent vNext secret %s", key)
		}
	}
}

func TestRunExportsOptionalProviderCredentials(t *testing.T) {
	for key, value := range map[string]string{
		"SEED_AUDIO_API_KEY": "test-seed-audio-key",
		"MINIMAX_API_KEY":    "test-minimax-key",
		"NEWAPI_API_KEY":     "test-newapi-key",
		"WECOM_CORP_SECRET":  "test-wecom-secret",
	} {
		t.Run(key, func(t *testing.T) {
			values := validSecrets()
			values[key] = value

			output, err := runForTest(t, values, validEnv())
			if err != nil {
				t.Fatal(err)
			}
			content, err := os.ReadFile(output)
			if err != nil {
				t.Fatal(err)
			}
			if !strings.Contains(string(content), "export "+key+"=") {
				t.Fatalf("missing optional provider credential export for %s", key)
			}
		})
	}
}

func TestRunExportsCompleteColGatewayCredentials(t *testing.T) {
	values := validSecrets()
	values["COL_BASE_URL"] = "https://company-gateway.example.invalid"
	values["COL_APIKEY"] = "test-col-key"

	output, err := runForTest(t, values, validEnv())
	if err != nil {
		t.Fatal(err)
	}
	content, err := os.ReadFile(output)
	if err != nil {
		t.Fatal(err)
	}
	for _, key := range []string{"COL_BASE_URL", "COL_APIKEY"} {
		if !strings.Contains(string(content), "export "+key+"=") {
			t.Fatalf("missing COL gateway credential export for %s", key)
		}
	}
}

func TestRunRejectsPartialColGatewayCredentials(t *testing.T) {
	for _, key := range []string{"COL_BASE_URL", "COL_APIKEY"} {
		values := validSecrets()
		values[key] = "configured"
		_, err := runForTest(t, values, validEnv())
		if err == nil || !strings.Contains(err.Error(), "COL_BASE_URL and COL_APIKEY") {
			t.Fatalf("run() error = %v, want complete COL gateway pair", err)
		}
	}
}

func TestRunRejectsUnsafeOptionalProviderCredentials(t *testing.T) {
	for _, key := range optionalProviderSecretKeys {
		for _, value := range []string{"", "has\nnewline", "has\x00nul"} {
			values := validSecrets()
			values[key] = value
			_, err := runForTest(t, values, validEnv())
			if err == nil || !strings.Contains(err.Error(), key) {
				t.Fatalf("run() error = %v, want invalid %s", err, key)
			}
		}
	}
}

func TestRunRejectsUnsafeWecomSecretWithoutLeakingValue(t *testing.T) {
	values := validSecrets()
	values["WECOM_CORP_SECRET"] = "sensitive\nvalue"
	output, err := runForTest(t, values, validEnv())
	if err == nil || !strings.Contains(err.Error(), "WECOM_CORP_SECRET") {
		t.Fatalf("run() error = %v, want invalid WECOM_CORP_SECRET", err)
	}
	if strings.Contains(err.Error(), "sensitive") {
		t.Fatalf("run() leaked the invalid secret value: %v", err)
	}
	if _, statErr := os.Stat(output); !os.IsNotExist(statErr) {
		t.Fatalf("validation failure created an export file: %v", statErr)
	}
}

func TestRunExportsCompleteOptionalRegistrationCredentials(t *testing.T) {
	values := validSecrets()
	values["VOLCENGINE_ACCESS_KEY_ID"] = "test-registration-access"
	values["VOLCENGINE_SECRET_ACCESS_KEY"] = "test-registration-secret"
	values["VOLCENGINE_SECURITY_TOKEN"] = "test-registration-session"

	output, err := runForTest(t, values, validEnv())
	if err != nil {
		t.Fatal(err)
	}
	content, err := os.ReadFile(output)
	if err != nil {
		t.Fatal(err)
	}
	for _, key := range []string{
		"VOLCENGINE_ACCESS_KEY_ID",
		"VOLCENGINE_SECRET_ACCESS_KEY",
		"VOLCENGINE_SECURITY_TOKEN",
	} {
		if !strings.Contains(string(content), "export "+key+"=") {
			t.Fatalf("missing optional registration credential export for %s", key)
		}
	}
}

func TestRunExportsOptionalRegistrationCredentialPairWithoutSessionToken(t *testing.T) {
	values := validSecrets()
	values["VOLCENGINE_ACCESS_KEY_ID"] = "test-registration-access"
	values["VOLCENGINE_SECRET_ACCESS_KEY"] = "test-registration-secret"

	output, err := runForTest(t, values, validEnv())
	if err != nil {
		t.Fatal(err)
	}
	content, err := os.ReadFile(output)
	if err != nil {
		t.Fatal(err)
	}
	for _, key := range []string{
		"VOLCENGINE_ACCESS_KEY_ID",
		"VOLCENGINE_SECRET_ACCESS_KEY",
	} {
		if !strings.Contains(string(content), "export "+key+"=") {
			t.Fatalf("missing optional registration credential export for %s", key)
		}
	}
	if strings.Contains(string(content), "export VOLCENGINE_SECURITY_TOKEN=") {
		t.Fatal("optional session token was exported when absent")
	}
}

func TestRunRejectsIncompleteOptionalRegistrationCredentials(t *testing.T) {
	for name, mutate := range map[string]func(map[string]string){
		"access key without secret key": func(values map[string]string) {
			values["VOLCENGINE_ACCESS_KEY_ID"] = "test-registration-access"
		},
		"secret key without access key": func(values map[string]string) {
			values["VOLCENGINE_SECRET_ACCESS_KEY"] = "test-registration-secret"
		},
		"session token without credential pair": func(values map[string]string) {
			values["VOLCENGINE_SECURITY_TOKEN"] = "test-registration-session"
		},
	} {
		t.Run(name, func(t *testing.T) {
			values := validSecrets()
			mutate(values)
			_, err := runForTest(t, values, validEnv())
			if err == nil {
				t.Fatal("run() accepted incomplete optional registration credentials")
			}
		})
	}
}

func TestRunLeavesExistingOutputUntouchedOnValidationFailure(t *testing.T) {
	dir := t.TempDir()
	output := filepath.Join(dir, "production-secrets.sh")
	const previous = "previous-good-output\n"
	if err := os.WriteFile(output, []byte(previous), 0o600); err != nil {
		t.Fatal(err)
	}
	values := validSecrets()
	values["POSTGRES_PASSWORD"] = ""
	rawBytes, err := json.Marshal(values)
	if err != nil {
		t.Fatal(err)
	}
	err = run(
		[]string{"--secret-name", "shortdrama/test/runtime", "--region", "cn-beijing", "--output", output},
		func(key string) string { return validEnv()[key] },
		func(_, _ string) (string, error) { return string(rawBytes), nil },
	)
	if err == nil {
		t.Fatal("run() accepted an empty POSTGRES_PASSWORD")
	}
	got, readErr := os.ReadFile(output)
	if readErr != nil {
		t.Fatal(readErr)
	}
	if string(got) != previous {
		t.Fatalf("failed run changed existing output: %q", got)
	}
}

func TestRunRejectsSecretNameOutsideAllowlistBeforeFetch(t *testing.T) {
	for _, name := range []string{
		"other/secret",
		"shortdrama/production",
		"shortdrama/staging/runtime",
		"shortdrama/test/Runtime",
		"shortdrama/test/",
		"shortdrama/test/runtime/extra",
	} {
		fetched := false
		err := run(
			[]string{"--secret-name", name, "--region", "cn-beijing", "--output", filepath.Join(t.TempDir(), "out")},
			func(string) string { return "" },
			func(_, _ string) (string, error) { fetched = true; return "{}", nil },
		)
		if err == nil || fetched {
			t.Fatalf("run() with secret name %q: error = %v, fetched = %v", name, err, fetched)
		}
	}
}

func TestRunRequiresSecretName(t *testing.T) {
	fetched := false
	err := run(
		[]string{"--region", "cn-beijing", "--output", filepath.Join(t.TempDir(), "out")},
		func(string) string { return "" },
		func(_, _ string) (string, error) { fetched = true; return "{}", nil },
	)
	if err == nil || fetched {
		t.Fatalf("run() without --secret-name: error = %v, fetched = %v", err, fetched)
	}
}

func TestRunAcceptsAllowlistedSecretNames(t *testing.T) {
	for _, name := range []string{"shortdrama/dev/runtime", "shortdrama/test/runtime", "shortdrama/prod/runtime"} {
		fetched := false
		err := run(
			[]string{"--secret-name", name, "--region", "cn-beijing", "--output", filepath.Join(t.TempDir(), "out")},
			func(string) string { return "" },
			func(_, _ string) (string, error) { fetched = true; return "", errors.New("stop after fetch") },
		)
		if !fetched || err == nil {
			t.Fatalf("run() with secret name %q: fetched = %v, error = %v", name, fetched, err)
		}
	}
}

func runForTest(t *testing.T, values, env map[string]string) (string, error) {
	t.Helper()
	dir := t.TempDir()
	output := filepath.Join(dir, "production-secrets.sh")
	rawBytes, err := json.Marshal(values)
	if err != nil {
		t.Fatal(err)
	}
	raw := string(rawBytes)
	err = run(
		[]string{"--secret-name", "shortdrama/test/runtime", "--region", "cn-beijing", "--output", output},
		func(key string) string { return env[key] },
		func(_, _ string) (string, error) { return raw, nil },
	)
	return output, err
}

func runVnextForTest(t *testing.T, values map[string]string) (string, error) {
	t.Helper()
	dir := t.TempDir()
	output := filepath.Join(dir, "vnext-secrets.sh")
	rawBytes, err := json.Marshal(values)
	if err != nil {
		t.Fatal(err)
	}
	err = run(
		[]string{"--secret-name", "shortdrama/test/vnext-runtime", "--region", "cn-beijing", "--output", output},
		func(string) string { return "" },
		func(_, _ string) (string, error) { return string(rawBytes), nil },
	)
	return output, err
}

func runMigratorForTest(t *testing.T, values map[string]string) (string, error) {
	t.Helper()
	dir := t.TempDir()
	output := filepath.Join(dir, "migrator-secrets.sh")
	rawBytes, err := json.Marshal(values)
	if err != nil {
		t.Fatal(err)
	}
	err = run(
		[]string{"--secret-name", "shortdrama/test/migrator", "--region", "cn-beijing", "--output", output},
		func(string) string { return "" },
		func(_, _ string) (string, error) { return string(rawBytes), nil },
	)
	return output, err
}

func validSecrets() map[string]string {
	return map[string]string{
		"ARK_API_KEY": "ark", "TOS_ACCESS_KEY": "tos-ak", "TOS_SECRET_KEY": "tos-sk",
		"POSTGRES_PASSWORD": "postgres", "MILVUS_PASSWORD": "milvus",
	}
}

func vnextRuntimeSecrets() map[string]string {
	return map[string]string{
		"VNEXT_DATABASE_URL":             "postgresql://vnext_runtime:test-password@db.internal:5432/shortdrama",
		"VNEXT_STORYBOARD_IMAGE_API_KEY": "test-storyboard-api-key",
	}
}

func validEnv() map[string]string {
	return map[string]string{
		"POSTGRES_HOST": "db.internal", "POSTGRES_PORT": "5432", "POSTGRES_DB": "shortdrama",
		"POSTGRES_USER": "app", "POSTGRES_SSL_MODE": "verify-full", "POSTGRES_SSL_ROOT_CERT": "/etc/ssl/root.pem",
	}
}
