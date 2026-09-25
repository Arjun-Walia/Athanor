package membership

import (
	"errors"
	"net"
	"sync"
	"time"

	"github.com/hashicorp/memberlist"
)

// filterTransport wraps memberlist's UDP/TCP transport so the demo can cut
// gossip between specific pairs of nodes (a partial partition) without
// iptables. Blocked peers' packets are dropped in both directions and dials
// to them fail, exactly as if the network between the two had gone away.
type filterTransport struct {
	inner   *memberlist.NetTransport
	blocked func(name, addr string) bool

	packets  chan *memberlist.Packet
	streams  chan net.Conn
	shutdown chan struct{}
	once     sync.Once
}

var errPartitioned = errors.New("membership: peer is partitioned away")

func newFilterTransport(inner *memberlist.NetTransport, blocked func(name, addr string) bool) *filterTransport {
	t := &filterTransport{
		inner:    inner,
		blocked:  blocked,
		packets:  make(chan *memberlist.Packet),
		streams:  make(chan net.Conn),
		shutdown: make(chan struct{}),
	}
	go t.pumpPackets()
	go t.pumpStreams()
	return t
}

func (t *filterTransport) pumpPackets() {
	for {
		select {
		case <-t.shutdown:
			return
		case p := <-t.inner.PacketCh():
			if p == nil || t.blocked("", p.From.String()) {
				continue
			}
			select {
			case t.packets <- p:
			case <-t.shutdown:
				return
			}
		}
	}
}

func (t *filterTransport) pumpStreams() {
	for {
		select {
		case <-t.shutdown:
			return
		case c := <-t.inner.StreamCh():
			if c == nil {
				continue
			}
			select {
			case t.streams <- c:
			case <-t.shutdown:
				_ = c.Close()
				return
			}
		}
	}
}

func (t *filterTransport) FinalAdvertiseAddr(ip string, port int) (net.IP, int, error) {
	return t.inner.FinalAdvertiseAddr(ip, port)
}

func (t *filterTransport) WriteTo(b []byte, addr string) (time.Time, error) {
	if t.blocked("", addr) {
		return time.Now(), nil // dropped on the floor, like a lost datagram
	}
	return t.inner.WriteTo(b, addr)
}

func (t *filterTransport) WriteToAddress(b []byte, a memberlist.Address) (time.Time, error) {
	if t.blocked(a.Name, a.Addr) {
		return time.Now(), nil
	}
	return t.inner.WriteTo(b, a.Addr)
}

func (t *filterTransport) PacketCh() <-chan *memberlist.Packet { return t.packets }

func (t *filterTransport) DialTimeout(addr string, timeout time.Duration) (net.Conn, error) {
	if t.blocked("", addr) {
		return nil, errPartitioned
	}
	return t.inner.DialTimeout(addr, timeout)
}

func (t *filterTransport) DialAddressTimeout(a memberlist.Address, timeout time.Duration) (net.Conn, error) {
	if t.blocked(a.Name, a.Addr) {
		return nil, errPartitioned
	}
	return t.inner.DialTimeout(a.Addr, timeout)
}

func (t *filterTransport) StreamCh() <-chan net.Conn { return t.streams }

// Shutdown stops the inner transport first. Its listeners hand packets and
// connections over unbuffered channels, so the pumps must keep draining them
// until those listeners have exited, or the inner shutdown blocks forever.
func (t *filterTransport) Shutdown() error {
	err := t.inner.Shutdown()
	t.once.Do(func() { close(t.shutdown) })
	return err
}
