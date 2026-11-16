// Package devserve holds the local dev server's extras: HTTPS, so the studio opened from another
// device on the LAN is a secure context (browsers give AudioWorklet, which the djrust engine runs
// in, only to https pages and localhost).
//
// Production does not use it: nginx terminates TLS there.
package devserve

import (
	"crypto/tls"
	"errors"
)

// TLSConfig loads a certificate and key (both, or neither: nil, nil for plain http).
func TLSConfig(certFile, keyFile string) (*tls.Config, error) {
	if certFile == "" && keyFile == "" {
		return nil, nil
	}
	if certFile == "" || keyFile == "" {
		return nil, errors.New("-tls-cert and -tls-key go together")
	}
	cert, err := tls.LoadX509KeyPair(certFile, keyFile)
	if err != nil {
		return nil, err
	}
	return &tls.Config{Certificates: []tls.Certificate{cert}, MinVersion: tls.VersionTLS12}, nil
}
