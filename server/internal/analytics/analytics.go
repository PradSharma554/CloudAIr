// Package analytics buffers agent-request events in memory and batch-writes
// them to Postgres, so recording never blocks agent traffic.
package analytics

import (
	"context"
	"log/slog"
	"sync"
	"sync/atomic"
	"time"

	"github.com/PradSharma554/CloudAIr/server/internal/store"
)

type Recorder struct {
	st       *store.Store
	events   chan store.AgentRequest
	dropped  atomic.Int64
	done     chan struct{}
	finished chan struct{}
	once     sync.Once
}

func NewRecorder(st *store.Store) *Recorder {
	r := &Recorder{
		st:       st,
		events:   make(chan store.AgentRequest, 1000),
		done:     make(chan struct{}),
		finished: make(chan struct{}),
	}
	go r.run()
	return r
}

// Record enqueues an event; drops (with a counter) rather than blocking when
// the buffer is full.
func (r *Recorder) Record(e store.AgentRequest) {
	if e.TS.IsZero() {
		e.TS = time.Now()
	}
	select {
	case r.events <- e:
	default:
		r.dropped.Add(1)
	}
}

func (r *Recorder) Dropped() int64 { return r.dropped.Load() }

func (r *Recorder) run() {
	defer close(r.finished)
	ticker := time.NewTicker(5 * time.Second)
	defer ticker.Stop()
	batch := make([]store.AgentRequest, 0, 128)
	flush := func() {
		if len(batch) == 0 {
			return
		}
		ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		if err := r.st.InsertAgentRequests(ctx, batch); err != nil {
			slog.Error("analytics flush failed", "err", err, "events", len(batch))
		}
		cancel()
		batch = batch[:0]
	}
	for {
		select {
		case e := <-r.events:
			batch = append(batch, e)
			if len(batch) >= 100 {
				flush()
			}
		case <-ticker.C:
			flush()
		case <-r.done:
			// Drain whatever is queued, then final flush (SIGTERM path —
			// Render sends one before spin-down).
			for {
				select {
				case e := <-r.events:
					batch = append(batch, e)
				default:
					flush()
					return
				}
			}
		}
	}
}

// Close flushes remaining events; safe to call once during graceful shutdown.
func (r *Recorder) Close() {
	r.once.Do(func() { close(r.done) })
	select {
	case <-r.finished:
	case <-time.After(15 * time.Second):
		slog.Warn("analytics recorder shutdown timed out")
	}
}
