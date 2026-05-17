package main

import (
	"fmt"
	"net/http"
	"runtime"
	"time"
)

var metricsProcessStart = time.Now()

// handleMetrics serves a Prometheus text-format /metrics endpoint scraped
// by the Datadog agent's openmetrics check on pflow.dev. The check's
// namespace `beats_bitwrap` is applied by the agent, so metric names
// here are unprefixed.
func handleMetrics(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Content-Type", "text/plain; version=0.0.4; charset=utf-8")
	var m runtime.MemStats
	runtime.ReadMemStats(&m)
	fmt.Fprintln(w, "# HELP up Service health gauge. Always 1 while the process is serving.")
	fmt.Fprintln(w, "# TYPE up gauge")
	fmt.Fprintln(w, "up 1")
	fmt.Fprintln(w, "# HELP process_start_time_seconds Unix timestamp when the process started.")
	fmt.Fprintln(w, "# TYPE process_start_time_seconds gauge")
	fmt.Fprintf(w, "process_start_time_seconds %d\n", metricsProcessStart.Unix())
	fmt.Fprintln(w, "# HELP go_goroutines Current goroutine count.")
	fmt.Fprintln(w, "# TYPE go_goroutines gauge")
	fmt.Fprintf(w, "go_goroutines %d\n", runtime.NumGoroutine())
	fmt.Fprintln(w, "# HELP go_memstats_alloc_bytes Live heap bytes currently allocated.")
	fmt.Fprintln(w, "# TYPE go_memstats_alloc_bytes gauge")
	fmt.Fprintf(w, "go_memstats_alloc_bytes %d\n", m.Alloc)
}
