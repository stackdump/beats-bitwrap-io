//go:build unix

package btwd

import "syscall"

// Renice lowers the priority of process pid to nice level n (n <= 0: left alone). btwd checks and renders are
// CPU-bound and the service shares its host with others: a hostile program, or just a busy hour of renders,
// must not be able to starve them. Errors are ignored (a process that has already exited, a system that says no).
func Renice(pid, n int) {
	if n > 0 && pid > 0 {
		_ = syscall.Setpriority(syscall.PRIO_PROCESS, pid, n)
	}
}
