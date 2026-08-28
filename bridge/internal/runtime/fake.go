package runtime

import (
	"context"
	"fmt"
	"sync"

	contracts "convenewire.dev/contracts/generated/go"
)

type FakeScript struct {
	ExpectedInstruction string
	Events              []Event
}

type FakeAdapter struct {
	mu       sync.Mutex
	scripts  []FakeScript
	requests []Request
}

func (f *FakeAdapter) Name() string { return "fake" }

func (f *FakeAdapter) Capabilities() Capabilities {
	return Capabilities{SupportsStreaming: true, SupportsInterrupt: true}
}

func (f *FakeAdapter) Enqueue(script FakeScript) error {
	if len(script.Events) == 0 {
		return fmt.Errorf("Fake Adapter script requires events")
	}
	terminal := false
	for _, event := range script.Events {
		if terminal {
			return fmt.Errorf("Fake Adapter cannot emit after terminal status")
		}
		if event.Status != nil && isTerminal(*event.Status) {
			terminal = true
		}
	}
	if !terminal {
		return fmt.Errorf("Fake Adapter script requires a terminal status")
	}
	f.mu.Lock()
	defer f.mu.Unlock()
	f.scripts = append(f.scripts, script)
	return nil
}

func (f *FakeAdapter) Execute(ctx context.Context, request Request, emit EmitFunc) error {
	f.mu.Lock()
	if len(f.scripts) == 0 {
		f.mu.Unlock()
		return fmt.Errorf("Fake Adapter has no queued script")
	}
	script := f.scripts[0]
	f.scripts = f.scripts[1:]
	f.requests = append(f.requests, request)
	f.mu.Unlock()
	if script.ExpectedInstruction != "" && script.ExpectedInstruction != request.Run.Instruction {
		return fmt.Errorf("Fake Adapter received unexpected instruction")
	}
	for _, event := range script.Events {
		if err := emit(ctx, event); err != nil {
			return err
		}
	}
	return nil
}

func (f *FakeAdapter) Requests() []Request {
	f.mu.Lock()
	defer f.mu.Unlock()
	return append([]Request(nil), f.requests...)
}

func isTerminal(status contracts.RunExecutionStatus) bool {
	return status == contracts.InputRequired || status == contracts.Completed || status == contracts.Failed ||
		status == contracts.Canceled || status == contracts.OutcomeUnknown
}
