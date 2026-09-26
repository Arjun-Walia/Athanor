package main

import (
	"strings"
	"testing"
)

func TestSeedListDefaultsThePort(t *testing.T) {
	got := seedList(" node2, node3:7000 ,,10.0.0.5")
	want := []string{"node2:7946", "node3:7000", "10.0.0.5:7946"}
	if strings.Join(got, ",") != strings.Join(want, ",") {
		t.Fatalf("seedList = %v, want %v", got, want)
	}
	if seedList("") != nil {
		t.Fatal("empty seeds should be nil")
	}
}

func TestEnvName(t *testing.T) {
	if envName("public-url") != "ATHANOR_PUBLIC_URL" || envName("n") != "ATHANOR_N" {
		t.Fatalf("envName = %q, %q", envName("public-url"), envName("n"))
	}
}

func TestParseFlagsEnvThenFlagsWin(t *testing.T) {
	t.Setenv("ATHANOR_PUBLIC_URL", "https://env.example")
	t.Setenv("ATHANOR_W", "3")
	s, err := parseFlags([]string{"--id", "node7", "--w", "1", "--http", ":9000"})
	if err != nil {
		t.Fatal(err)
	}
	if s.id != "node7" || s.publicURL != "https://env.example" || s.quorum.W != 1 || s.httpAddr != ":9000" {
		t.Fatalf("settings = %+v", s)
	}
}

func TestParseFlagsDerivesPublicURLAndRejectsBadInput(t *testing.T) {
	s, err := parseFlags([]string{"--http", "127.0.0.1:8123", "--tls-cert", "c.pem", "--tls-key", "k.pem"})
	if err != nil || s.publicURL != "https://localhost:8123" {
		t.Fatalf("tls public url = %q, %v", s.publicURL, err)
	}
	s, err = parseFlags([]string{"--http", ":8081"})
	if err != nil || s.publicURL != "http://localhost:8081" {
		t.Fatalf("plain public url = %q, %v", s.publicURL, err)
	}
	for _, args := range [][]string{
		{"--id", "bad id"},
		{"--n", "1", "--w", "2"},
		{"--tls-cert", "only-cert.pem"},
		{"--w", "not-a-number"},
	} {
		if _, err := parseFlags(args); err == nil {
			t.Fatalf("%v accepted", args)
		}
	}
	t.Setenv("ATHANOR_N", "zero?")
	if _, err := parseFlags(nil); err == nil || !strings.Contains(err.Error(), "ATHANOR_N") {
		t.Fatalf("bad env value should name the variable: %v", err)
	}
}

func TestIsLocal(t *testing.T) {
	if !isLocal("http://localhost:8081") || !isLocal("http://127.0.0.1:1") || isLocal("https://www.athanor.cfd") {
		t.Fatal("isLocal misjudged an address")
	}
}
