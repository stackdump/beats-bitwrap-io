// Command fakebtwd is the test double for the Rust btwd binary (see package fakebtwd).
package main

import (
	"os"

	"beats-bitwrap-io/internal/btwsite/btwd/fakebtwd"
)

func main() { os.Exit(fakebtwd.Run(os.Args[1:], os.Stdin, os.Stdout, os.Stderr)) }
