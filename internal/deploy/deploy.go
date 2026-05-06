// Package deploy implements GitHub-webhook-driven self-redeploy for the
// beats-bitwrap-io service, mirroring the pattern used by stackdump-com,
// blog-stackdump-com, modeldao-org, etc.
//
// Routes (registered by Register):
//   - POST /webhook/github  - HMAC-verified GitHub push hook
//   - POST /admin/deploy    - manual trigger (X-Deploy-Token or ?token=)
//   - GET  /admin/logs      - tail tmux pane for the service
//
// Activation: requires DEPLOY_SECRET env var. Returns 503 otherwise so the
// route is safe to leave registered in non-prod builds.
package deploy

import (
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"log"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"time"
)

func deploySecret() string { return os.Getenv("DEPLOY_SECRET") }

func workspaceRoot() string {
	if v := os.Getenv("WORKSPACE_ROOT"); v != "" {
		return v
	}
	home, _ := os.UserHomeDir()
	return filepath.Join(home, "Workspace")
}

func tmuxSession() string {
	if v := os.Getenv("TMUX_SESSION"); v != "" {
		return v
	}
	return "servers"
}

func projectDirName() string {
	if v := os.Getenv("PROJECT_DIR"); v != "" {
		return v
	}
	return "beats-bitwrap-io"
}

func serviceName() string {
	if v := os.Getenv("SERVICE_NAME"); v != "" {
		return v
	}
	return "beats-bitwrap"
}

// Register attaches the deploy routes to mux.
func Register(mux *http.ServeMux) {
	mux.HandleFunc("/webhook/github", handleWebhook)
	mux.HandleFunc("/admin/deploy", handleAdminDeploy)
	mux.HandleFunc("/admin/logs", handleAdminLogs)
}

func verifyHMAC(secret string, body []byte, signature string) bool {
	if !strings.HasPrefix(signature, "sha256=") {
		return false
	}
	sig, err := hex.DecodeString(signature[7:])
	if err != nil {
		return false
	}
	mac := hmac.New(sha256.New, []byte(secret))
	mac.Write(body)
	return hmac.Equal(sig, mac.Sum(nil))
}

func checkDeployAuth(r *http.Request) bool {
	secret := deploySecret()
	if secret == "" {
		return false
	}
	if r.Header.Get("X-Deploy-Token") == secret {
		return true
	}
	if r.URL.Query().Get("token") == secret {
		return true
	}
	return false
}

func handleWebhook(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	secret := deploySecret()
	if secret == "" {
		http.Error(w, "deploy not configured", http.StatusServiceUnavailable)
		return
	}

	body, err := io.ReadAll(io.LimitReader(r.Body, 1<<20))
	if err != nil {
		http.Error(w, "failed to read body", http.StatusBadRequest)
		return
	}

	if !verifyHMAC(secret, body, r.Header.Get("X-Hub-Signature-256")) {
		http.Error(w, "invalid signature", http.StatusForbidden)
		return
	}

	var payload struct {
		Ref string `json:"ref"`
	}
	if err := json.Unmarshal(body, &payload); err != nil {
		http.Error(w, "invalid JSON", http.StatusBadRequest)
		return
	}

	if payload.Ref != "refs/heads/main" {
		w.WriteHeader(http.StatusOK)
		fmt.Fprintf(w, "ignored: %s", payload.Ref)
		return
	}

	go func() {
		log.Printf("[deploy] webhook triggered for %s", payload.Ref)
		output, err := runDeploySync()
		if err != nil {
			log.Printf("[deploy] failed: %v\n%s", err, output)
			return
		}
		log.Printf("[deploy] success, scheduling restart")
		scheduleRestart()
	}()

	w.WriteHeader(http.StatusAccepted)
	fmt.Fprintf(w, "deploy started")
}

func handleAdminDeploy(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	if !checkDeployAuth(r) {
		http.Error(w, "unauthorized", http.StatusUnauthorized)
		return
	}

	flusher, ok := w.(http.Flusher)
	if !ok {
		http.Error(w, "streaming not supported", http.StatusInternalServerError)
		return
	}

	rc := http.NewResponseController(w)
	_ = rc.SetWriteDeadline(time.Now().Add(5 * time.Minute))

	w.Header().Set("Content-Type", "text/plain; charset=utf-8")
	w.Header().Set("X-Content-Type-Options", "nosniff")
	w.WriteHeader(http.StatusOK)

	write := func(msg string) { fmt.Fprint(w, msg); flusher.Flush() }

	write("Starting deploy...\n\n")
	output, err := runDeploySync()
	write(output)
	if err != nil {
		write(fmt.Sprintf("\nDEPLOY FAILED: %v\n", err))
		return
	}
	write("\nDeploy succeeded. Scheduling restart in 2s...\n")
	flusher.Flush()
	go scheduleRestart()
}

func handleAdminLogs(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	if !checkDeployAuth(r) {
		http.Error(w, "unauthorized", http.StatusUnauthorized)
		return
	}

	lines := 100
	if v := r.URL.Query().Get("lines"); v != "" {
		if n, err := strconv.Atoi(v); err == nil && n > 0 {
			if n > 1000 {
				n = 1000
			}
			lines = n
		}
	}

	target := fmt.Sprintf("%s:%s", tmuxSession(), serviceName())
	cmd := exec.Command("tmux", "capture-pane", "-t", target, "-p", "-S", fmt.Sprintf("-%d", lines))
	out, err := cmd.CombinedOutput()
	if err != nil {
		http.Error(w, fmt.Sprintf("tmux error: %v\n%s", err, out), http.StatusInternalServerError)
		return
	}
	w.Header().Set("Content-Type", "text/plain; charset=utf-8")
	w.Write(out)
}

// runDeploySync runs git pull + make build in the project dir.
func runDeploySync() (string, error) {
	var buf strings.Builder
	projectDir := filepath.Join(workspaceRoot(), projectDirName())

	run := func(desc string, args ...string) error {
		buf.WriteString(fmt.Sprintf("==> %s\n    cd %s && %s\n", desc, projectDir, strings.Join(args, " ")))
		cmd := exec.Command(args[0], args[1:]...)
		cmd.Dir = projectDir
		out, err := cmd.CombinedOutput()
		buf.Write(out)
		buf.WriteString("\n")
		if err != nil {
			return fmt.Errorf("%s: %w", desc, err)
		}
		return nil
	}

	if err := run("git pull", "git", "pull", "--ff-only"); err != nil {
		return buf.String(), err
	}
	if err := run("make build", "make", "build"); err != nil {
		return buf.String(), err
	}
	buf.WriteString("==> Build complete\n")
	return buf.String(), nil
}

// scheduleRestart hands off to ~/services and exits so the new binary takes over.
func scheduleRestart() {
	time.Sleep(2 * time.Second)
	home, _ := os.UserHomeDir()
	servicesScript := filepath.Join(home, "services")
	log.Printf("[deploy] restarting %s via %s", serviceName(), servicesScript)

	cmd := exec.Command("nohup", servicesScript, "restart", serviceName())
	cmd.Stdout = os.Stdout
	cmd.Stderr = os.Stderr
	if err := cmd.Start(); err != nil {
		log.Printf("[deploy] restart failed: %v", err)
		return
	}
	_ = cmd.Process.Release()
	log.Printf("[deploy] exiting for restart")
	os.Exit(0)
}
