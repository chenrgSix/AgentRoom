package delivery

import (
	"context"
	"sync"
)

type executionWaiter struct {
	ready chan struct{}
}

// AgentExecutionGate keeps one active Runtime invocation per Agent while
// preserving independent concurrency across Agent identities.
type AgentExecutionGate struct {
	mu     sync.Mutex
	active map[string]bool
	queues map[string][]*executionWaiter
}

func NewAgentExecutionGate() *AgentExecutionGate {
	return &AgentExecutionGate{
		active: make(map[string]bool),
		queues: make(map[string][]*executionWaiter),
	}
}

func (g *AgentExecutionGate) Acquire(ctx context.Context, agentID string) (func(), error) {
	g.mu.Lock()
	if !g.active[agentID] {
		g.active[agentID] = true
		g.mu.Unlock()
		return g.releaseFunc(agentID), nil
	}
	waiter := &executionWaiter{ready: make(chan struct{})}
	g.queues[agentID] = append(g.queues[agentID], waiter)
	g.mu.Unlock()

	select {
	case <-waiter.ready:
		if err := ctx.Err(); err != nil {
			g.release(agentID)
			return nil, err
		}
		return g.releaseFunc(agentID), nil
	case <-ctx.Done():
		g.mu.Lock()
		queue := g.queues[agentID]
		removed := false
		for index, candidate := range queue {
			if candidate != waiter {
				continue
			}
			g.queues[agentID] = append(queue[:index], queue[index+1:]...)
			if len(g.queues[agentID]) == 0 {
				delete(g.queues, agentID)
			}
			removed = true
			break
		}
		g.mu.Unlock()
		if !removed {
			// Release selected this waiter concurrently with cancellation.
			g.release(agentID)
		}
		return nil, ctx.Err()
	}
}

func (g *AgentExecutionGate) releaseFunc(agentID string) func() {
	var once sync.Once
	return func() {
		once.Do(func() { g.release(agentID) })
	}
}

func (g *AgentExecutionGate) release(agentID string) {
	g.mu.Lock()
	defer g.mu.Unlock()
	queue := g.queues[agentID]
	if len(queue) == 0 {
		delete(g.active, agentID)
		delete(g.queues, agentID)
		return
	}
	next := queue[0]
	queue = queue[1:]
	if len(queue) == 0 {
		delete(g.queues, agentID)
	} else {
		g.queues[agentID] = queue
	}
	close(next.ready)
}
