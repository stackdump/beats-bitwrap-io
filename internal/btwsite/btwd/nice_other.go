//go:build !unix

package btwd

// Renice is a no-op where there is no setpriority.
func Renice(pid, n int) {}
