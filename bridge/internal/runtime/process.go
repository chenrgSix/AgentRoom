package runtime

// runtimeCommand owns the platform-specific process lifecycle. On Unix the
// implementation is the exec.Cmd itself; Windows uses a Job Object wrapper so
// cancellation and normal teardown include every descendant process.
type runtimeCommand interface {
	Start() error
	Wait() error
	Run() error
}
