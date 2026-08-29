package controller

import (
	"slices"
	"testing"
)

func TestClosedCommandEnvironmentRejectsAmbientProductOverrides(t *testing.T) {
	result := closedCommandEnvironment([]string{
		"HOME=/safe/home",
		"PATH=/safe/bin",
		"DOCKER_HOST=unix:///safe/docker.sock",
		"CONVENE_WIRE_DATABASE_PATH=/data/ambient.sqlite",
		"CONVENE_WIRE_PUBLIC_ORIGIN=https://ambient.example",
		"AGENT_ROOM_DOMAIN=ambient.example",
	}, map[string]string{
		"CONVENE_WIRE_BRIDGE_SERVER_TOKEN": "explicit-secret",
		"AGENT_ROOM_BRIDGE_SERVER_TOKEN":   "explicit-secret",
	})

	for _, inherited := range []string{
		"HOME=/safe/home",
		"PATH=/safe/bin",
		"DOCKER_HOST=unix:///safe/docker.sock",
	} {
		if !slices.Contains(result, inherited) {
			t.Fatalf("closed environment omitted ordinary host value %q: %#v", inherited, result)
		}
	}
	for _, rejected := range []string{
		"CONVENE_WIRE_DATABASE_PATH=/data/ambient.sqlite",
		"CONVENE_WIRE_PUBLIC_ORIGIN=https://ambient.example",
		"AGENT_ROOM_DOMAIN=ambient.example",
	} {
		if slices.Contains(result, rejected) {
			t.Fatalf("closed environment retained ambient product override %q", rejected)
		}
	}
	for _, explicit := range []string{
		"CONVENE_WIRE_BRIDGE_SERVER_TOKEN=explicit-secret",
		"AGENT_ROOM_BRIDGE_SERVER_TOKEN=explicit-secret",
	} {
		if !slices.Contains(result, explicit) {
			t.Fatalf("closed environment omitted explicit controller value %q: %#v", explicit, result)
		}
	}
}

func TestClosedCommandEnvironmentUsesExplicitProductValue(t *testing.T) {
	result := closedCommandEnvironment([]string{
		"CONVENE_WIRE_DATABASE_PATH=/data/ambient.sqlite",
	}, map[string]string{
		"CONVENE_WIRE_DATABASE_PATH": "/data/authoritative.sqlite",
	})

	if !slices.Equal(result, []string{
		"CONVENE_WIRE_DATABASE_PATH=/data/authoritative.sqlite",
	}) {
		t.Fatalf("explicit controller value did not replace ambient state: %#v", result)
	}
}
