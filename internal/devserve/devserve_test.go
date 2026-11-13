package devserve

import (
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/x509"
	"crypto/x509/pkix"
	"encoding/pem"
	"math/big"
	"net"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"testing"
	"time"
)

func TestPkgHandler(t *testing.T) {
	dir := t.TempDir()
	os.WriteFile(filepath.Join(dir, "djrust.js"), []byte("export const x = 1;"), 0o644)
	os.WriteFile(filepath.Join(dir, "djrust_bg.wasm"), []byte("\x00asm\x01\x00\x00\x00"), 0o644)
	if err := CheckPkg(dir); err != nil {
		t.Fatal(err)
	}
	if err := CheckPkg(t.TempDir()); err == nil {
		t.Fatal("an empty dir passed as a djrust build")
	}
	h := PkgHandler(dir)
	for path, want := range map[string]string{
		PkgPrefix + "djrust_bg.wasm": "application/wasm",
		PkgPrefix + "djrust.js":      "text/javascript; charset=utf-8",
	} {
		rec := httptest.NewRecorder()
		h.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, path, nil))
		if rec.Code != 200 || rec.Header().Get("Content-Type") != want || rec.Header().Get("Cache-Control") != "no-store" {
			t.Errorf("%s: %d %q %q", path, rec.Code, rec.Header().Get("Content-Type"), rec.Header().Get("Cache-Control"))
		}
	}
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, PkgPrefix+"../devserve.go", nil))
	if rec.Code == 200 {
		t.Error("served a file outside the package directory")
	}
}

func TestTLSConfig(t *testing.T) {
	if c, err := TLSConfig("", ""); c != nil || err != nil {
		t.Fatalf("no cert: %v %v", c, err)
	}
	if _, err := TLSConfig("cert.pem", ""); err == nil {
		t.Fatal("a cert without a key was accepted")
	}
	dir := t.TempDir()
	certFile, keyFile := filepath.Join(dir, "c.pem"), filepath.Join(dir, "k.pem")
	key, _ := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	tmpl := &x509.Certificate{SerialNumber: big.NewInt(1), Subject: pkix.Name{CommonName: "beats dev"},
		NotBefore: time.Now().Add(-time.Hour), NotAfter: time.Now().Add(time.Hour),
		IPAddresses: []net.IP{net.ParseIP("127.0.0.1")}}
	der, err := x509.CreateCertificate(rand.Reader, tmpl, tmpl, &key.PublicKey, key)
	if err != nil {
		t.Fatal(err)
	}
	kder, _ := x509.MarshalECPrivateKey(key)
	os.WriteFile(certFile, pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: der}), 0o600)
	os.WriteFile(keyFile, pem.EncodeToMemory(&pem.Block{Type: "EC PRIVATE KEY", Bytes: kder}), 0o600)
	c, err := TLSConfig(certFile, keyFile)
	if err != nil || c == nil || len(c.Certificates) != 1 {
		t.Fatalf("load: %v", err)
	}
}
